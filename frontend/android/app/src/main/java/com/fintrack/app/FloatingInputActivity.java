package com.fintrack.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class FloatingInputActivity extends Activity {
    public static final String EXTRA_MODE = "mode";
    private static final int SPEECH_REQUEST_CODE = 4101;
    private static final String API_URL = "https://capable-adaptation-production-7733.up.railway.app/api/transactions/quick-add";
    private final ExecutorService requestExecutor = Executors.newSingleThreadExecutor();
    private EditText input;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }

        String mode = getIntent().getStringExtra(EXTRA_MODE);
        if ("VOICE".equals(mode)) {
            startVoiceRecognition();
            return;
        }

        setContentView(R.layout.activity_floating_input);
        input = findViewById(R.id.floating_input_text);
        Button send = findViewById(R.id.floating_input_send);
        send.setOnClickListener(view -> submitText());
        input.setOnEditorActionListener((view, actionId, event) -> {
            submitText();
            return true;
        });
        input.requestFocus();
        input.postDelayed(() -> ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                .showSoftInput(input, InputMethodManager.SHOW_IMPLICIT), 150);
    }

    private void startVoiceRecognition() {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, new Locale("pt", "BR"));
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "Diga seu gasto ou ganho");
        try {
            startActivityForResult(intent, SPEECH_REQUEST_CODE);
        } catch (Exception error) {
            showToastAndFinish("Reconhecimento de voz indisponivel.");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != SPEECH_REQUEST_CODE) return;
        if (resultCode != RESULT_OK || data == null) {
            finish();
            return;
        }
        ArrayList<String> results = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (results == null || results.isEmpty() || results.get(0).trim().isEmpty()) {
            showToastAndFinish("Nenhum lancamento foi reconhecido.");
            return;
        }
        sendQuickAdd(results.get(0).trim());
    }

    private void submitText() {
        String text = input == null ? "" : input.getText().toString().trim();
        if (text.isEmpty()) {
            input.setError("Informe um gasto ou ganho");
            return;
        }
        ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(input.getWindowToken(), 0);
        sendQuickAdd(text);
    }

    private void sendQuickAdd(String text) {
        requestExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                SharedPreferences preferences = getSharedPreferences("CapacitorStorage", MODE_PRIVATE);
                String token = preferences.getString("auth_token", "");
                if (token.isEmpty()) {
                    showToastAndFinish("Entre no FinTrack para registrar.");
                    return;
                }

                connection = (HttpURLConnection) new URL(API_URL).openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(15000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                connection.setRequestProperty("Authorization", "Bearer " + token);
                JSONObject body = new JSONObject();
                body.put("text", text);
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(payload);
                }

                int status = connection.getResponseCode();
                InputStream responseStream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                String responseBody = readResponse(responseStream);
                if (status < 200 || status >= 300) {
                    JSONObject error = new JSONObject(responseBody);
                    showToastAndFinish(error.optString("message", "Nao foi possivel registrar o lancamento."));
                    return;
                }
                JSONObject response = new JSONObject(responseBody);
                showToastAndFinish(response.optString("message", "Lancamento adicionado com sucesso!"));
            } catch (Exception error) {
                showToastAndFinish("Nao foi possivel conectar ao FinTrack.");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private String readResponse(InputStream stream) throws Exception {
        if (stream == null) return "{}";
        StringBuilder body = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
        }
        return body.toString();
    }

    private void showToastAndFinish(String message) {
        runOnUiThread(() -> {
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
            finish();
        });
    }

    @Override
    protected void onDestroy() {
        requestExecutor.shutdownNow();
        super.onDestroy();
    }
}
