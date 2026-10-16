package org.usecloak.agent;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.ContactsContract.PhoneLookup;
import android.telephony.SmsManager;

import java.util.ArrayList;

/** Phone-number helpers, contact lookup and sending. */
final class Sms {
    private Sms() {}

    static String digits(String s) { return s == null ? "" : s.replaceAll("[^0-9]", ""); }

    /** Last 10 digits — matches +1 (555) 123-4567 against 5551234567. */
    static String key(String n) {
        String d = digits(n);
        return d.length() > 10 ? d.substring(d.length() - 10) : d;
    }

    /** Real people only: no short codes (banks, 2FA, carriers) and no alphanumeric senders. */
    static boolean isPerson(String from) {
        if (from == null || from.matches(".*[A-Za-z].*")) return false;
        return digits(from).length() >= 7;
    }

    static String contactName(Context c, String number) {
        if (c.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) return null;
        Uri u = Uri.withAppendedPath(PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
        try (Cursor cur = c.getContentResolver().query(u, new String[]{PhoneLookup.DISPLAY_NAME}, null, null, null)) {
            if (cur != null && cur.moveToFirst()) return cur.getString(0);
        } catch (Exception ignored) {
        }
        return null;
    }

    /** Replies on the SIM the text came in on. The system files it in the Messages thread. */
    @SuppressWarnings("deprecation")
    static void send(Context c, String to, String body, int sub) {
        SmsManager sm = null;
        if (Build.VERSION.SDK_INT >= 31) {
            sm = c.getSystemService(SmsManager.class);
            if (sm != null && sub >= 0) sm = sm.createForSubscriptionId(sub);
        } else if (sub >= 0) {
            sm = SmsManager.getSmsManagerForSubscriptionId(sub);
        }
        if (sm == null) sm = SmsManager.getDefault();
        ArrayList<String> parts = sm.divideMessage(body);
        if (parts.size() == 1) sm.sendTextMessage(to, null, body, null, null);
        else sm.sendMultipartTextMessage(to, null, parts, null, null);
    }
}
