package com.studiotune.pro;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * Servicio en primer plano que graba audio en un archivo PCM 16 bit mono (44100 Hz) mientras la app
 * está en segundo plano. Dos fuentes:
 *  - "internal": audio que reproducen otras apps (AudioPlaybackCapture + MediaProjection).
 *  - "mic": micrófono (UNPROCESSED si existe, para evitar el control automático de ganancia).
 */
public class CaptureService extends Service {

    public interface Listener {
        void onStarted();
        void onError(String message);
        void onLevel(double rms, double seconds);
        void onWindow(String base64Pcm16);
        void onFinished();
    }

    public static final int SAMPLE_RATE = 44100;
    public static final int WINDOW = 16384;
    public static final String ACTION_START = "com.studiotune.pro.START";
    public static final String EXTRA_SOURCE = "source";
    public static final String EXTRA_CODE = "code";
    public static final String EXTRA_DATA = "data";
    private static final String CHANNEL = "capture";
    private static final int NOTIF_ID = 1001;

    public static volatile Listener listener;
    private static volatile CaptureService instance;
    private static volatile String lastPath = null;
    private static volatile long lastSamples = 0;

    private AudioRecord rec;
    private MediaProjection projection;
    private Thread thread;
    private volatile boolean stopFlag = false;
    private BufferedOutputStream out;
    private File outFile;
    private long totalSamples = 0;
    private boolean started = false;
    private boolean autoStop = false, autoEnded = false;
    private long maxSamples = 0;

    /** Resultado de una grabación terminada. */
    public static class Result {
        public final String path; public final long samples;
        Result(String p, long s) { path = p; samples = s; }
    }

    /** Detiene la grabación en curso (si la hay) y devuelve el archivo resultante. */
    public static Result stopAndGet() {
        CaptureService s = instance;
        if (s != null) s.finish(false);
        return lastPath == null ? null : new Result(lastPath, lastSamples);
    }

    public static boolean isRunning() { return instance != null; }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !ACTION_START.equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        final boolean internal = "internal".equals(intent.getStringExtra(EXTRA_SOURCE));
        lastPath = null; lastSamples = 0; autoEnded = false;
        autoStop = intent.getBooleanExtra("autoStop", false);
        maxSamples = (long) (intent.getDoubleExtra("maxSeconds", 0) * SAMPLE_RATE);
        createChannel();
        try {
            Notification n = buildNotification(internal);
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n, internal ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                                                      : ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) { fail("No se pudo iniciar el servicio: " + e.getMessage()); return START_NOT_STICKY; }

        instance = this;
        try {
            final int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            final int bufBytes = Math.max(minBuf * 4, WINDOW * 4);
            final AudioFormat fmt = new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build();
            if (internal) {
                if (Build.VERSION.SDK_INT < 29) throw new IllegalStateException("Requiere Android 10 o superior");
                MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
                @SuppressWarnings("deprecation") Intent data = intent.getParcelableExtra(EXTRA_DATA);
                projection = mpm.getMediaProjection(intent.getIntExtra(EXTRA_CODE, 0), data);
                if (projection == null) throw new IllegalStateException("Permiso de captura no válido");
                projection.registerCallback(new MediaProjection.Callback() {
                    @Override public void onStop() { stopFlag = true; }
                }, new Handler(Looper.getMainLooper()));
                AudioPlaybackCaptureConfiguration cfg = new AudioPlaybackCaptureConfiguration.Builder(projection)
                        .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                        .addMatchingUsage(AudioAttributes.USAGE_GAME)
                        .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                        .build();
                rec = new AudioRecord.Builder().setAudioPlaybackCaptureConfig(cfg).setAudioFormat(fmt)
                        .setBufferSizeInBytes(bufBytes).build();
            } else {
                rec = new AudioRecord(MediaRecorder.AudioSource.UNPROCESSED, SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufBytes);
                if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                    rec.release();
                    rec = new AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
                            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufBytes);
                }
            }
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("No se pudo abrir la entrada de audio");

            outFile = new File(getCacheDir(), "capture.pcm");
            out = new BufferedOutputStream(new FileOutputStream(outFile), 1 << 16);
            totalSamples = 0; stopFlag = false;
            rec.startRecording();
            if (rec.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException("La grabación no arrancó");
        } catch (Exception e) { fail(e.getMessage() == null ? e.toString() : e.getMessage()); return START_NOT_STICKY; }

        started = true;
        thread = new Thread(this::loop, "capture-loop");
        thread.start();
        Listener l = listener;
        if (l != null) l.onStarted();
        return START_NOT_STICKY;
    }

    private void loop() {
        final short[] buf = new short[4096];
        final short[] ring = new short[WINDOW];
        final byte[] bytes = new byte[buf.length * 2];
        long ringCount = 0; int ringPos = 0;
        long lastWin = System.currentTimeMillis(), lastLvl = lastWin;
        double sumSq = 0; long sumN = 0;
        double soundSec = 0, silenceRun = 0;
        try {
            while (!stopFlag) {
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) { if (n < 0) break; continue; }
                for (int i = 0; i < n; i++) {
                    short s = buf[i];
                    bytes[2 * i] = (byte) (s & 0xff); bytes[2 * i + 1] = (byte) ((s >> 8) & 0xff);
                    ring[ringPos] = s; ringPos = (ringPos + 1) % WINDOW;
                    sumSq += (double) s * s;
                }
                sumN += n; ringCount += n; totalSamples += n;
                out.write(bytes, 0, n * 2);
                long now = System.currentTimeMillis();
                Listener l = listener;
                if (now - lastLvl >= 200 && sumN > 0) {
                    double rms = Math.sqrt(sumSq / sumN) / 32768.0, dt = (now - lastLvl) / 1000.0;
                    if (rms > 0.003) { soundSec += dt; silenceRun = 0; } else { silenceRun += dt; }
                    if (l != null) l.onLevel(rms, totalSamples / (double) SAMPLE_RATE);
                    sumSq = 0; sumN = 0; lastLvl = now;
                    // fin automático: duración máxima, o música seguida de un silencio largo
                    if ((autoStop && soundSec >= 20 && silenceRun >= 5) || (maxSamples > 0 && totalSamples >= maxSamples)) { autoEnded = true; break; }
                }
                if (l != null && now - lastWin >= 500 && ringCount >= WINDOW) {
                    byte[] w = new byte[WINDOW * 2];
                    for (int i = 0; i < WINDOW; i++) {
                        short s = ring[(ringPos + i) % WINDOW];
                        w[2 * i] = (byte) (s & 0xff); w[2 * i + 1] = (byte) ((s >> 8) & 0xff);
                    }
                    l.onWindow(Base64.encodeToString(w, Base64.NO_WRAP));
                    lastWin = now;
                }
            }
        } catch (IOException e) {
            Listener l = listener; if (l != null) l.onError("Error al guardar el audio: " + e.getMessage());
        }
        if (autoEnded) {
            finish(true);
            Listener l = listener; if (l != null) l.onFinished();
        }
    }

    /** Termina la grabación, cierra el archivo y libera recursos. Idempotente. */
    private synchronized void finish(boolean fromLoop) {
        if (instance == null) return;
        stopFlag = true;
        try { if (!fromLoop && thread != null) thread.join(2000); } catch (InterruptedException ignored) { }
        try { if (rec != null) { if (started) rec.stop(); rec.release(); } } catch (Exception ignored) { }
        rec = null;
        try { if (out != null) { out.flush(); out.close(); } } catch (IOException ignored) { }
        out = null;
        if (projection != null) { try { projection.stop(); } catch (Exception ignored) { } projection = null; }
        if (outFile != null) { lastPath = outFile.getAbsolutePath(); lastSamples = totalSamples; }
        instance = null;
        stopForeground(true);
        if (autoEnded) notifyDone();
        stopSelf();
    }

    /** Aviso final cuando la grabación terminó sola (app en segundo plano). */
    private void notifyDone() {
        try {
            Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
            PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
            Notification n = b.setSmallIcon(R.drawable.ic_stat_note).setContentTitle("Grabación terminada")
                    .setContentText("Toca para ver los acordes de la canción.").setContentIntent(pi).setAutoCancel(true).build();
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(1002, n);
        } catch (Exception ignored) { }
    }

    @Override public void onDestroy() { if (instance == this) finish(false); super.onDestroy(); }

    private void fail(String msg) {
        Listener l = listener; if (l != null) l.onError(msg);
        try { if (rec != null) rec.release(); } catch (Exception ignored) { }
        rec = null;
        if (projection != null) { try { projection.stop(); } catch (Exception ignored) { } projection = null; }
        instance = null;
        stopForeground(true);
        stopSelf();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Grabación de audio", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Aviso mientras StudioTune Pro escucha la canción");
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(boolean internal) {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setSmallIcon(R.drawable.ic_stat_note)
                .setContentTitle("StudioTune Pro está escuchando")
                .setContentText(internal ? "Capturando el audio del teléfono. Toca para volver y detener." : "Grabando con el micrófono. Toca para volver y detener.")
                .setContentIntent(pi).setOngoing(true).build();
    }
}
