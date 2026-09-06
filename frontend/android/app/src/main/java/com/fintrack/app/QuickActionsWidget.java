package com.fintrack.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

public class QuickActionsWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_quick_actions);
            views.setOnClickPendingIntent(R.id.btn_widget_input_text, createPendingIntent(context, "TEXT", 0));
            views.setOnClickPendingIntent(R.id.btn_widget_mic, createPendingIntent(context, "VOICE", 1));
            appWidgetManager.updateAppWidget(appWidgetId, views);
        }
    }

    private PendingIntent createPendingIntent(Context context, String mode, int requestCode) {
        Intent intent = new Intent(context, FloatingInputActivity.class);
        intent.putExtra(FloatingInputActivity.EXTRA_MODE, mode);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
