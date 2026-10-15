package org.usecloak.agent;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** One screen: status, setup checklist, settings, RAM tools, console, activity log. */
public final class MainActivity extends Activity {
    // Cloak tokens (cloak.css)
    private static final int INK = 0xFF0A0A0A, PAPER = 0xFFF2EEE5, SURF = 0xFFFAFAF7, P2 = 0xFFEAE5DB,
            ACC = 0xFFD44D2A, MUTED = 0xFF6B675F;
    private static final String[] MODELS = {"pneuma", "logos", "kairos"};

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable refresher = new Runnable() {
        @Override
        public void run() {
            refresh();
            ui.postDelayed(this, 4000);
        }
    };

    private float dp;
    private Switch swEnabled, swContacts, swRam;
    private TextView status, ramOut, console, log;
    private RadioGroup persona, model;
    private EditText name, extra, delay, owners, ramEvery, keep, sleepList, input;
    private Button send;
    private final List<Runnable> setupRows = new ArrayList<>();

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        dp = getResources().getDisplayMetrics().density;
        getWindow().setStatusBarColor(PAPER);
        getWindow().setNavigationBarColor(PAPER);
        int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 27) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        getWindow().getDecorView().setSystemUiVisibility(flags);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(PAPER);
        scroll.setFitsSystemWindows(true);
        LinearLayout root = column();
        root.setPadding(px(16), px(18), px(16), px(32));
        scroll.addView(root);
        setContentView(scroll);

        // Header
        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.BOTTOM);
        head.addView(text("CLOAK", 30, INK, true));
        TextView agent = text(" AGENT", 30, ACC, true);
        head.addView(agent);
        root.addView(head);
        root.addView(text(version(), 12, MUTED, false));
        gap(root, 14);

        // Status
        LinearLayout st = card(root);
        swEnabled = toggle(st, "Auto-reply to texts", Prefs.enabled(this));
        status = text("", 13, MUTED, false);
        st.addView(status);
        swEnabled.setOnCheckedChangeListener((v, on) -> {
            save();
            Prefs.put(this, Prefs.ENABLED, on);
            AgentService.sync(this);
            refresh();
        });

        // Setup checklist
        LinearLayout setup = card(root);
        section(setup, "Setup");
        setupRow(setup, "SMS access", this::smsGranted, () ->
                requestPermissions(new String[]{Manifest.permission.RECEIVE_SMS, Manifest.permission.SEND_SMS}, 1));
        setupRow(setup, "Contacts (names + contacts-only)", () -> granted(Manifest.permission.READ_CONTACTS), () ->
                requestPermissions(new String[]{Manifest.permission.READ_CONTACTS}, 2));
        if (Build.VERSION.SDK_INT >= 33) {
            setupRow(setup, "Notification (keeps it alive)", () -> granted(Manifest.permission.POST_NOTIFICATIONS), () ->
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 3));
        }
        setupRow(setup, "Phone control (Accessibility)", () -> PhoneControl.instance != null, () ->
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        setupRow(setup, "Run unrestricted (battery)", this::unrestricted, () ->
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName()))));
        TextView hint = text("Accessibility greyed out? App info → ⋮ → Allow restricted settings, then try again. "
                + "Using Google Messages? Turn off RCS chats on this phone so every text arrives as SMS.", 12, MUTED, false);
        setup.addView(hint);
        Button info = button("Open app info", false);
        info.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getPackageName()))));
        setup.addView(info, wrap());

        // Replies
        LinearLayout rep = card(root);
        section(rep, "Who's replying");
        persona = radios(rep, new String[]{"Cloak (people text Cloak)", "Cloak answering for me"},
                "me".equals(Prefs.str(this, Prefs.PERSONA, "cloak")) ? 1 : 0, true);
        name = field(rep, "Your name", Prefs.str(this, Prefs.NAME, ""), false);
        extra = field(rep, "Extra instructions (tone, what to say, what not to)", Prefs.str(this, Prefs.EXTRA, ""), true);
        rep.addView(text("Model", 12, MUTED, true));
        int mi = 0;
        for (int i = 0; i < MODELS.length; i++) if (MODELS[i].equals(Prefs.str(this, Prefs.MODEL, "pneuma"))) mi = i;
        model = radios(rep, new String[]{"Pneuma", "Logos", "Kairos"}, mi, false);
        delay = field(rep, "Wait for more texts (seconds)", String.valueOf(Prefs.num(this, Prefs.DELAY, 6)), false);
        delay.setInputType(InputType.TYPE_CLASS_NUMBER);
        swContacts = toggle(rep, "Only reply to contacts", Prefs.bool(this, Prefs.CONTACTS_ONLY, true));
        owners = field(rep, "Your number(s) — texts from these can control the phone", Prefs.str(this, Prefs.OWNERS, ""), false);
        owners.setInputType(InputType.TYPE_CLASS_PHONE);
        rep.addView(text("Never replies to short codes (banks, 2FA). Anyone can text STOP to mute it.", 12, MUTED, false));

        // RAM
        LinearLayout ram = card(root);
        section(ram, "RAM saver");
        swRam = toggle(ram, "Stop background apps automatically", Prefs.ramSaver(this));
        swRam.setOnCheckedChangeListener((v, on) -> {
            Prefs.put(this, Prefs.RAM, on);
            AgentService.sync(this);
        });
        ramEvery = field(ram, "Every (minutes) — also on screen off + low memory",
                String.valueOf(Prefs.num(this, Prefs.RAM_EVERY, 20)), false);
        ramEvery.setInputType(InputType.TYPE_CLASS_NUMBER);
        keep = field(ram, "Never close (comma list, e.g. Spotify, WhatsApp)", Prefs.str(this, Prefs.KEEP, ""), false);
        sleepList = field(ram, "Sleep list — force-stopped on \"Sleep apps\"", Prefs.str(this, Prefs.SLEEP, ""), false);
        LinearLayout ramBtns = new LinearLayout(this);
        ramBtns.setOrientation(LinearLayout.HORIZONTAL);
        ramBtn(ramBtns, "Free RAM", "free_ram");
        ramBtn(ramBtns, "Clear recents", "close_all");
        ramBtn(ramBtns, "Sleep apps", "sleep");
        ram.addView(ramBtns);
        ramOut = text("", 12, MUTED, false);
        ram.addView(ramOut);

        // Console
        LinearLayout con = card(root);
        section(con, "Console — you, with phone control");
        console = text("Try: \"open YouTube\", \"what's on screen?\", \"free up RAM\", \"how's the battery?\"", 13, INK, false);
        console.setTypeface(Typeface.MONOSPACE);
        console.setTextIsSelectable(true);
        con.addView(console);
        input = field(con, "Message Cloak", "", true);
        LinearLayout conBtns = new LinearLayout(this);
        send = button("Send", true);
        send.setOnClickListener(v -> runConsole());
        conBtns.addView(send, wrap());
        Button clear = button("New chat", false);
        clear.setOnClickListener(v -> {
            Prefs.clearHistory(this, "console");
            console.setText("");
        });
        LinearLayout.LayoutParams lp = wrap();
        lp.leftMargin = px(10);
        conBtns.addView(clear, lp);
        con.addView(conBtns);

        // Log
        LinearLayout lg = card(root);
        section(lg, "Activity");
        log = text("", 12, INK, false);
        log.setTypeface(Typeface.MONOSPACE);
        lg.addView(log);

        AgentService.sync(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        ui.post(refresher);
    }

    @Override
    protected void onPause() {
        ui.removeCallbacks(refresher);
        save();
        super.onPause();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        refresh();
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    private void runConsole() {
        String msg = input.getText().toString().trim();
        if (msg.isEmpty()) return;
        save();
        input.setText("");
        send.setEnabled(false);
        appendConsole("\n\nyou: " + msg + "\n…");
        new Thread(() -> {
            String out;
            try {
                out = Agent.reply(this, "console", "you", msg, true, false,
                        line -> ui.post(() -> appendConsole("\n" + line)));
            } catch (Exception e) {
                out = "(couldn't reach Cloak: " + e.getMessage() + ")";
            }
            String reply = out.isEmpty() ? "(no reply)" : out;
            ui.post(() -> {
                appendConsole("\ncloak: " + reply);
                send.setEnabled(true);
            });
        }).start();
    }

    private void appendConsole(String s) {
        CharSequence cur = console.getText();
        String next = cur + s;
        console.setText(next.length() > 6000 ? next.substring(next.length() - 6000) : next);
    }

    private void ramBtn(LinearLayout row, String label, String action) {
        Button btn = button(label, false);
        btn.setOnClickListener(v -> {
            save();
            ramOut.setText("working…");
            new Thread(() -> {
                String r = Actions.run(this, action, "");
                ui.post(() -> ramOut.setText(r));
            }).start();
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        lp.rightMargin = px(6);
        row.addView(btn, lp);
    }

    private void save() {
        if (name == null) return;
        Prefs.put(this, Prefs.PERSONA, persona.getCheckedRadioButtonId() == 2 ? "me" : "cloak");
        Prefs.put(this, Prefs.NAME, name.getText().toString().trim());
        Prefs.put(this, Prefs.EXTRA, extra.getText().toString().trim());
        int m = model.getCheckedRadioButtonId() - 1;
        Prefs.put(this, Prefs.MODEL, MODELS[m >= 0 && m < MODELS.length ? m : 0]);
        Prefs.put(this, Prefs.DELAY, intOf(delay, 6));
        Prefs.put(this, Prefs.CONTACTS_ONLY, swContacts.isChecked());
        Prefs.put(this, Prefs.OWNERS, owners.getText().toString().trim());
        Prefs.put(this, Prefs.RAM_EVERY, Math.max(5, intOf(ramEvery, 20)));
        Prefs.put(this, Prefs.KEEP, keep.getText().toString().trim());
        Prefs.put(this, Prefs.SLEEP, sleepList.getText().toString().trim());
    }

    private void refresh() {
        for (Runnable r : setupRows) r.run();
        StringBuilder s = new StringBuilder();
        if (!Prefs.enabled(this)) s.append("Off.");
        else if (!smsGranted()) s.append("Needs SMS access.");
        else s.append("Running · ").append(Prefs.count(this, "replies")).append(" replies today.");
        s.append(PhoneControl.instance != null ? " Phone control on." : " Phone control off.");
        if (Prefs.enabled(this) && swContacts.isChecked() && !granted(Manifest.permission.READ_CONTACTS)) {
            s.append(" Contacts-only is on but Contacts isn't granted, so nobody gets replies.");
        }
        status.setText(s);
        List<String> lines = Prefs.logs(this);
        log.setText(lines.isEmpty() ? "Nothing yet." : String.join("\n", lines));
    }

    private boolean granted(String p) { return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }

    private boolean smsGranted() {
        return granted(Manifest.permission.RECEIVE_SMS) && granted(Manifest.permission.SEND_SMS);
    }

    private boolean unrestricted() {
        return getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
    }

    private String version() {
        try {
            return "v" + getPackageManager().getPackageInfo(getPackageName(), 0).versionName + " · api.usecloak.org";
        } catch (Exception e) {
            return "api.usecloak.org";
        }
    }

    private static int intOf(EditText e, int def) {
        try {
            return Integer.parseInt(e.getText().toString().trim());
        } catch (Exception ex) {
            return def;
        }
    }

    // ── View kit (neobrutalist: 2dp ink borders, hard offset shadows) ───────

    private int px(int v) { return Math.round(v * dp); }

    private LinearLayout column() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    private void gap(LinearLayout parent, int h) {
        parent.addView(new View(this), new LinearLayout.LayoutParams(1, px(h)));
    }

    private LinearLayout.LayoutParams wrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, px(2), 0, px(2));
        return t;
    }

    private void section(LinearLayout parent, String s) {
        TextView t = text(s.toUpperCase(), 12, ACC, true);
        t.setLetterSpacing(0.08f);
        t.setPadding(0, 0, 0, px(6));
        parent.addView(t);
    }

    /** Face with a 2dp ink stroke over a hard ink shadow offset by `shadow` dp. */
    private Drawable box(int face, int shadow, boolean pressed) {
        int s = px(shadow);
        GradientDrawable fc = new GradientDrawable();
        fc.setColor(face);
        fc.setStroke(px(2), INK);
        if (pressed) {
            LayerDrawable l = new LayerDrawable(new Drawable[]{fc});
            l.setLayerInset(0, s, s, 0, 0);       // slams flat onto the shadow
            return l;
        }
        GradientDrawable sh = new GradientDrawable();
        sh.setColor(INK);
        LayerDrawable l = new LayerDrawable(new Drawable[]{sh, fc});
        l.setLayerInset(0, s, s, 0, 0);
        l.setLayerInset(1, 0, 0, s, s);
        return l;
    }

    private LinearLayout card(LinearLayout parent) {
        LinearLayout c = column();
        c.setBackground(box(SURF, 4, false));
        c.setPadding(px(14), px(12), px(18), px(16));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = px(14);
        parent.addView(c, lp);
        return c;
    }

    private Button button(String s, boolean primary) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(primary ? Color.WHITE : INK);
        b.setStateListAnimator(null);
        StateListDrawable sl = new StateListDrawable();
        sl.addState(new int[]{android.R.attr.state_pressed}, box(primary ? ACC : P2, 3, true));
        sl.addState(new int[]{}, box(primary ? ACC : P2, 3, false));
        b.setBackground(sl);
        b.setPadding(px(14), px(8), px(17), px(11));
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        return b;
    }

    private Switch toggle(LinearLayout parent, String label, boolean on) {
        Switch s = new Switch(this);
        s.setText(label);
        s.setTextSize(15);
        s.setTextColor(INK);
        s.setTypeface(Typeface.DEFAULT_BOLD);
        s.setChecked(on);
        int[][] states = {{android.R.attr.state_checked}, {}};
        s.setThumbTintList(new ColorStateList(states, new int[]{ACC, SURF}));
        s.setTrackTintList(new ColorStateList(states, new int[]{ACC, MUTED}));
        s.setPadding(0, px(6), 0, px(6));
        parent.addView(s, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        return s;
    }

    private EditText field(LinearLayout parent, String label, String value, boolean multi) {
        parent.addView(text(label, 12, MUTED, true));
        EditText e = new EditText(this);
        e.setText(value);
        e.setTextSize(15);
        e.setTextColor(INK);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setStroke(px(2), INK);
        e.setBackground(bg);
        e.setPadding(px(10), px(8), px(10), px(8));
        if (multi) {
            e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                    | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            e.setMinLines(2);
            e.setGravity(Gravity.TOP | Gravity.START);
        } else {
            e.setSingleLine(true);
        }
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = px(10);
        parent.addView(e, lp);
        return e;
    }

    /** RadioButton ids are index + 1, so getCheckedRadioButtonId() - 1 is the choice. */
    private RadioGroup radios(LinearLayout parent, String[] labels, int checked, boolean vertical) {
        RadioGroup g = new RadioGroup(this);
        g.setOrientation(vertical ? RadioGroup.VERTICAL : RadioGroup.HORIZONTAL);
        ColorStateList tint = new ColorStateList(new int[][]{{android.R.attr.state_checked}, {}}, new int[]{ACC, INK});
        for (int i = 0; i < labels.length; i++) {
            RadioButton r = new RadioButton(this);
            r.setId(i + 1);
            r.setText(labels[i]);
            r.setTextColor(INK);
            r.setButtonTintList(tint);
            r.setPadding(0, 0, px(12), 0);
            g.addView(r);
        }
        g.check(checked + 1);
        g.setPadding(0, 0, 0, px(8));
        parent.addView(g);
        return g;
    }

    private void setupRow(LinearLayout parent, String label, Check done, Runnable fix) {
        Button b = button("", false);
        b.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        b.setOnClickListener(v -> {
            if (!done.ok()) fix.run();
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = px(8);
        parent.addView(b, lp);
        setupRows.add(() -> {
            boolean ok = done.ok();
            b.setText((ok ? "✓  " : "→  ") + label);
            b.setTextColor(ok ? MUTED : INK);
        });
    }

    private interface Check { boolean ok(); }
}
