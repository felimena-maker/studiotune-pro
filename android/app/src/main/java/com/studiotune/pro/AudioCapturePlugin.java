package com.studiotune.pro;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Puente JS ↔ CaptureService. Métodos: start({source}), stop(). Eventos: "level", "window". */
@CapacitorPlugin(
        name = "AudioCapture",
        permissions = {
                @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "mic"),
                @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notif")
        })
public class AudioCapturePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "afterMic");
            return;
        }
        askNotifications(call);
    }

    @PermissionCallback
    private void afterMic(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) { call.reject("Permiso de micrófono denegado"); return; }
        askNotifications(call);
    }

    private void askNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notif") != PermissionState.GRANTED) {
            requestPermissionForAlias("notif", call, "afterNotif");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void afterNotif(PluginCall call) { launch(call); } // si se deniega, el servicio funciona igual (sin aviso visible)

    private void launch(PluginCall call) {
        String source = call.getString("source", "internal");
        if ("internal".equals(source)) {
            if (Build.VERSION.SDK_INT < 29) { call.reject("La captura de audio interno requiere Android 10 o superior"); return; }
            MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            startActivityForResult(call, mpm.createScreenCaptureIntent(), "projectionResult");
        } else {
            startService(call, "mic", 0, null);
        }
    }

    @ActivityCallback
    private void projectionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Permiso de captura de audio denegado");
            return;
        }
        startService(call, "internal", result.getResultCode(), result.getData());
    }

    private void startService(final PluginCall call, String source, int code, Intent data) {
        final boolean[] answered = { false };
        CaptureService.listener = new CaptureService.Listener() {
            @Override public void onStarted() { if (!answered[0]) { answered[0] = true; call.resolve(); } }
            @Override public void onError(String message) {
                if (!answered[0]) { answered[0] = true; call.reject(message); }
                else { JSObject o = new JSObject(); o.put("message", message); notifyListeners("error", o); }
            }
            @Override public void onLevel(double rms, double seconds) {
                JSObject o = new JSObject(); o.put("rms", rms); o.put("seconds", seconds); notifyListeners("level", o);
            }
            @Override public void onWindow(String b64) {
                JSObject o = new JSObject(); o.put("data", b64); notifyListeners("window", o);
            }
            @Override public void onFinished() { notifyListeners("finished", new JSObject()); }
        };
        Intent i = new Intent(getContext(), CaptureService.class);
        i.setAction(CaptureService.ACTION_START);
        i.putExtra(CaptureService.EXTRA_SOURCE, source);
        if (data != null) { i.putExtra(CaptureService.EXTRA_CODE, code); i.putExtra(CaptureService.EXTRA_DATA, data); }
        i.putExtra("autoStop", Boolean.TRUE.equals(call.getBoolean("autoStop", false)));
        Double ms = call.getDouble("maxSeconds", 0.0);
        i.putExtra("maxSeconds", ms == null ? 0.0 : ms);
        ContextCompat.startForegroundService(getContext(), i);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject o = new JSObject();
        o.put("running", CaptureService.isRunning());
        call.resolve(o);
    }

    /** Abre un enlace https en la app correspondiente (YouTube, Spotify…). */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) { call.reject("Enlace no válido"); return; }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) { call.reject("No se pudo abrir el enlace"); }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        CaptureService.Result r = CaptureService.stopAndGet();
        CaptureService.listener = null;
        if (r == null) { call.reject("No hay grabación"); return; }
        JSObject o = new JSObject();
        o.put("path", r.path);
        o.put("samples", r.samples);
        o.put("sampleRate", CaptureService.SAMPLE_RATE);
        o.put("seconds", r.samples / (double) CaptureService.SAMPLE_RATE);
        call.resolve(o);
    }
}
