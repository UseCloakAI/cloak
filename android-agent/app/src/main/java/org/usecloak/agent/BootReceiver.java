package org.usecloak.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Back on after a reboot or an update. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        AgentService.sync(c);
    }
}
