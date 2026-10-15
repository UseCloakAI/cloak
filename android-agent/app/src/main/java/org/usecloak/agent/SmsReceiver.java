package org.usecloak.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;

import java.util.LinkedHashMap;
import java.util.Map;

/** SMS_RECEIVED → AgentService. Joins multipart texts; the service does the slow part. */
public final class SmsReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction()) || !Prefs.enabled(c)) return;
        SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (parts == null) return;
        int sub = intent.getIntExtra("android.telephony.extra.SUBSCRIPTION_INDEX", intent.getIntExtra("subscription", -1));

        Map<String, StringBuilder> bySender = new LinkedHashMap<>();
        for (SmsMessage m : parts) {
            if (m == null || m.getOriginatingAddress() == null) continue;
            StringBuilder sb = bySender.get(m.getOriginatingAddress());
            if (sb == null) bySender.put(m.getOriginatingAddress(), sb = new StringBuilder());
            sb.append(m.getMessageBody());
        }
        for (Map.Entry<String, StringBuilder> e : bySender.entrySet()) {
            AgentService svc = AgentService.live;
            if (svc != null) {
                try {
                    svc.enqueue(e.getKey(), e.getValue().toString(), sub);
                    continue;
                } catch (Exception ignored) {
                    // shutting down — start it fresh below
                }
            }
            Intent i = new Intent(c, AgentService.class)
                    .putExtra(AgentService.EXTRA_FROM, e.getKey())
                    .putExtra(AgentService.EXTRA_BODY, e.getValue().toString())
                    .putExtra(AgentService.EXTRA_SUB, sub);
            try {
                c.startForegroundService(i);
            } catch (Exception ex) {
                Prefs.log(c, "couldn't wake the agent: " + ex.getMessage());
            }
        }
    }
}
