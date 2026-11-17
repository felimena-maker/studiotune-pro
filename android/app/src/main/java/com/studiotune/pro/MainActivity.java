package com.studiotune.pro;

import android.graphics.Color;
import android.os.Bundle;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioCapturePlugin.class);
        super.onCreate(savedInstanceState);
        // Mantener la pantalla encendida mientras se afina
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // Barras del sistema oscuras para combinar con la interfaz
        getWindow().setStatusBarColor(Color.parseColor("#09090B"));
        getWindow().setNavigationBarColor(Color.parseColor("#09090B"));
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setAppearanceLightStatusBars(false);
        c.setAppearanceLightNavigationBars(false);
    }
}
