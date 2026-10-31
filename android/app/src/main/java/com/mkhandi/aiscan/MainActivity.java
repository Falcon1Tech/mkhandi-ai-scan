package com.mkhandi.aiscan;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.View;
import android.view.Gravity;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.content.Intent;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://mkhandi-ai-scan.vercel.app";
    private static final int FILE_CHOOSER_REQUEST = 4201;
    private static final int BACKGROUND = Color.rgb(7, 11, 21);
    private static final int RED = Color.rgb(225, 29, 46);
    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout errorPanel;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean pageLoaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BACKGROUND);
        getWindow().setNavigationBarColor(BACKGROUND);
        if (Build.VERSION.SDK_INT >= 29) {
            getWindow().setNavigationBarDividerColor(Color.rgb(35, 40, 52));
        }
        getWindow().getDecorView().setSystemUiVisibility(0);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUserAgentString(settings.getUserAgentString() + " MKHANDIAndroid/1.5.0");
        webView.setBackgroundColor(BACKGROUND);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
                if ("https".equals(scheme) && (host.equals("mkhandi-ai-scan.vercel.app") || host.endsWith(".vercel.app"))) return false;
                if ("mailto".equals(scheme) || "tel".equals(scheme) || "https".equals(scheme)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
                    return true;
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageLoaded = false;
                progressBar.setVisibility(View.VISIBLE);
                errorPanel.setVisibility(View.GONE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                progressBar.setVisibility(View.GONE);
                errorPanel.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
                    showConnectionError();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> request.deny());
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(4);
        progressBar.setIndeterminate(false);
        progressBar.setProgressTintList(android.content.res.ColorStateList.valueOf(RED));
        progressBar.setBackgroundColor(Color.rgb(23, 28, 40));
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(-1, dp(3), Gravity.TOP);
        root.addView(progressBar, progressParams);

        errorPanel = buildErrorPanel();
        errorPanel.setVisibility(View.GONE);
        root.addView(errorPanel, new FrameLayout.LayoutParams(-1, -1));

        setContentView(root);
        if (savedInstanceState != null) {
            android.webkit.WebBackForwardList restored = webView.restoreState(savedInstanceState);
            if (restored == null || restored.getSize() == 0) webView.loadUrl(APP_URL);
        } else {
            webView.loadUrl(APP_URL);
        }
    }

    private LinearLayout buildErrorPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(28), dp(28), dp(28), dp(28));
        panel.setBackgroundColor(BACKGROUND);

        TextView mark = new TextView(this);
        mark.setText("M");
        mark.setTextColor(Color.WHITE);
        mark.setTextSize(28);
        mark.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        mark.setGravity(Gravity.CENTER);
        GradientDrawable badge = new GradientDrawable();
        badge.setColor(RED);
        badge.setCornerRadius(dp(18));
        mark.setBackground(badge);
        panel.addView(mark, new LinearLayout.LayoutParams(dp(64), dp(64)));

        TextView title = new TextView(this);
        title.setText("Connection interrupted");
        title.setTextColor(Color.WHITE);
        title.setTextSize(21);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(-1, -2);
        titleParams.topMargin = dp(24);
        panel.addView(title, titleParams);

        TextView detail = new TextView(this);
        detail.setText("MKHANDI AI SCAN could not reach the scanner. Check your internet connection, then try again.");
        detail.setTextColor(Color.rgb(172, 180, 195));
        detail.setTextSize(14);
        detail.setGravity(Gravity.CENTER);
        detail.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2);
        detailParams.topMargin = dp(10);
        panel.addView(detail, detailParams);

        Button retry = new Button(this);
        retry.setText("RECONNECT");
        retry.setTextColor(Color.WHITE);
        retry.setTextSize(13);
        retry.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        retry.setAllCaps(false);
        GradientDrawable buttonBg = new GradientDrawable();
        buttonBg.setColor(RED);
        buttonBg.setCornerRadius(dp(12));
        retry.setBackground(buttonBg);
        retry.setOnClickListener(v -> {
            errorPanel.setVisibility(View.GONE);
            progressBar.setProgress(4);
            progressBar.setVisibility(View.VISIBLE);
            webView.loadUrl(APP_URL);
        });
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(-1, dp(50));
        retryParams.topMargin = dp(24);
        panel.addView(retry, retryParams);

        TextView version = new TextView(this);
        version.setText("MKHANDI AI SCAN  •  ANDROID 1.5.0");
        version.setTextColor(Color.rgb(105, 115, 132));
        version.setTextSize(10);
        version.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams versionParams = new LinearLayout.LayoutParams(-1, -2);
        versionParams.topMargin = dp(22);
        panel.addView(version, versionParams);
        return panel;
    }

    private void showConnectionError() {
        runOnUiThread(() -> {
            if (pageLoaded) return;
            progressBar.setVisibility(View.GONE);
            errorPanel.setVisibility(View.VISIBLE);
        });
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && filePathCallback != null) {
            Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            // Recover automatically when the user returns after an offline interruption.
            try {
                android.net.ConnectivityManager cm =
                    (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                android.net.NetworkInfo network = cm == null ? null : cm.getActiveNetworkInfo();
                if (network != null && network.isConnected()
                    && errorPanel != null && errorPanel.getVisibility() == View.VISIBLE) {
                    errorPanel.setVisibility(View.GONE);
                    progressBar.setProgress(4);
                    progressBar.setVisibility(View.VISIBLE);
                    webView.loadUrl(APP_URL);
                }
            } catch (Exception ignored) {}
        }
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
