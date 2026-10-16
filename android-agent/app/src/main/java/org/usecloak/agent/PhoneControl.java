package org.usecloak.agent;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import java.util.ArrayDeque;
import java.util.List;

/**
 * Accessibility service = the agent's hands. Listens to window changes only (cheap) to
 * track the foreground app; reads / taps / types on demand. Also what lets Android start
 * other apps from the background.
 */
public final class PhoneControl extends AccessibilityService {
    static volatile PhoneControl instance;
    static volatile String foreground = "";

    @Override
    protected void onServiceConnected() {
        instance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || e.getPackageName() == null) return;
        String p = e.getPackageName().toString();
        if (!p.equals("com.android.systemui")) foreground = p;
    }

    @Override
    public void onInterrupt() {}

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    // ── Finding + acting on nodes ───────────────────────────────────────────

    static String label(AccessibilityNodeInfo n) {
        CharSequence t = n.getText();
        if (t == null || t.length() == 0) t = n.getContentDescription();
        return t == null ? "" : t.toString().trim();
    }

    static boolean enabled(AccessibilityNodeInfo n) {
        for (AccessibilityNodeInfo x = n; x != null; x = x.getParent()) {
            if (x.isClickable()) return x.isEnabled();
        }
        return n.isEnabled();
    }

    /** Every on-screen window root, top-most first: dialogs, the keyboard, then the app. */
    List<AccessibilityNodeInfo> roots() {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        try {
            for (AccessibilityWindowInfo w : getWindows()) {
                AccessibilityNodeInfo r = w.getRoot();
                if (r != null && w.getType() != AccessibilityWindowInfo.TYPE_SYSTEM) out.add(r);
            }
        } catch (Exception ignored) {
        }
        if (out.isEmpty()) {
            AccessibilityNodeInfo r = getRootInActiveWindow();
            if (r != null) out.add(r);
        }
        return out;
    }

    private static boolean isKeyboard(AccessibilityNodeInfo root) {
        AccessibilityWindowInfo w = root.getWindow();
        return w != null && w.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD;
    }

    /** First visible node whose label is exactly one of the phrases (case-insensitive), any window. */
    AccessibilityNodeInfo findExact(String... phrases) {
        for (AccessibilityNodeInfo root : roots()) {
            for (String p : phrases) {
                for (AccessibilityNodeInfo n : root.findAccessibilityNodeInfosByText(p)) {
                    if (n.isVisibleToUser() && label(n).equalsIgnoreCase(p)) return n;
                }
            }
        }
        return null;
    }

    /** Exact label match first (any window, keyboard included), then the first visible partial match. */
    AccessibilityNodeInfo find(String text) {
        if (text.isEmpty()) return null;
        AccessibilityNodeInfo partial = null;
        for (AccessibilityNodeInfo root : roots()) {
            for (AccessibilityNodeInfo n : root.findAccessibilityNodeInfosByText(text)) {
                if (!n.isVisibleToUser()) continue;
                if (label(n).equalsIgnoreCase(text)) return n;
                if (partial == null) partial = n;
            }
        }
        return partial;
    }

    boolean tapAt(int x, int y) {
        Path p = new Path();
        p.moveTo(x, y);
        return dispatchGesture(new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, 60)).build(), null, null);
    }

    String tapXY(String v) {
        String[] xy = v.replaceAll("[^0-9,]", "").split(",");
        if (xy.length != 2 || xy[0].isEmpty() || xy[1].isEmpty()) return "need v=\"x,y\"";
        boolean ok = tapAt(Integer.parseInt(xy[0]), Integer.parseInt(xy[1]));
        Actions.pause(900);
        return ok ? "tapped at " + xy[0] + "," + xy[1] : "couldn't tap there";
    }

    /** Submits the focused field (the keyboard's Go / Search / Enter). */
    String enter() {
        for (AccessibilityNodeInfo root : roots()) {
            AccessibilityNodeInfo f = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (f != null && Build.VERSION.SDK_INT >= 30
                    && f.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
                Actions.pause(1200);
                return "pressed enter";
            }
        }
        AccessibilityNodeInfo key = findExact("Go", "Search", "Enter", "Done", "Send", "Next");
        if (key != null && click(key)) {
            Actions.pause(1200);
            return "pressed " + label(key);
        }
        return "no focused field or enter key";
    }

    /** Screenshot → small JPEG → Cloak's vision model. Android 11+. */
    String look(String question) {
        if (Build.VERSION.SDK_INT < 30) return "can't take screenshots on this Android version — use screen";
        CountDownLatch done = new CountDownLatch(1);
        Bitmap[] shot = new Bitmap[1];
        String[] err = new String[1];
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult r) {
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                    shot[0] = hw == null ? null : hw.copy(Bitmap.Config.ARGB_8888, false);
                    r.getHardwareBuffer().close();
                } catch (Exception e) {
                    err[0] = e.getMessage();
                }
                done.countDown();
            }

            @Override
            public void onFailure(int code) {
                err[0] = "screenshot failed (" + code + ")";
                done.countDown();
            }
        });
        try {
            if (!done.await(5, TimeUnit.SECONDS)) return "screenshot timed out";
        } catch (InterruptedException e) {
            return "interrupted";
        }
        if (shot[0] == null) return err[0] != null ? err[0] : "screenshot failed";
        Bitmap b = shot[0];
        int w = 720, h = Math.round(b.getHeight() * (720f / b.getWidth()));
        Bitmap small = Bitmap.createScaledBitmap(b, w, h, true);
        ByteArrayOutputStream jpg = new ByteArrayOutputStream();
        small.compress(Bitmap.CompressFormat.JPEG, 70, jpg);
        b.recycle();
        small.recycle();
        String q = (question.isEmpty() ? "Describe this phone screen: the app, what's shown, buttons, the keyboard if open."
                : question) + " The image is " + w + "px wide; screen coordinates are the image's times "
                + String.format(java.util.Locale.US, "%.2f", getResources().getDisplayMetrics().widthPixels / (float) w) + ".";
        try {
            return "screenshot: " + CloakApi.look(Base64.encodeToString(jpg.toByteArray(), Base64.NO_WRAP), q);
        } catch (Exception e) {
            return "vision failed: " + e.getMessage();
        }
    }

    boolean click(AccessibilityNodeInfo n) {
        for (AccessibilityNodeInfo x = n; x != null; x = x.getParent()) {
            if (x.isClickable() && x.isEnabled()) return x.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        }
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        return tapAt(b.centerX(), b.centerY());
    }

    String tap(String text) {
        AccessibilityNodeInfo n = find(text);
        if (n == null) return "no \"" + text + "\" on screen";
        boolean ok = click(n);
        Actions.pause(900);
        return ok ? "tapped \"" + label(n) + "\"" : "couldn't tap \"" + text + "\"";
    }

    String type(String text) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "can't read the screen";
        AccessibilityNodeInfo f = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (f == null || !f.isEditable()) f = first(root, true);
        if (f == null) return "no text field on screen";
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b) ? "typed" : "couldn't type";
    }

    boolean scroll(boolean forward) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        AccessibilityNodeInfo n = root == null ? null : first(root, false);
        return n != null && n.performAction(forward
                ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);
    }

    /** BFS for the first editable (or scrollable) node. */
    private static AccessibilityNodeInfo first(AccessibilityNodeInfo root, boolean editable) {
        ArrayDeque<AccessibilityNodeInfo> q = new ArrayDeque<>();
        q.add(root);
        for (int seen = 0; !q.isEmpty() && seen < 800; seen++) {
            AccessibilityNodeInfo n = q.poll();
            if (n.isVisibleToUser() && (editable ? n.isEditable() : n.isScrollable())) return n;
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo ch = n.getChild(i);
                if (ch != null) q.add(ch);
            }
        }
        return null;
    }

    // ── Screen dump for the model ───────────────────────────────────────────

    /** Text of every window (app, dialogs, keyboard). Tap targets carry @x,y screen centers. */
    String dump(int max) {
        List<AccessibilityNodeInfo> rs = roots();
        if (rs.isEmpty()) return "can't read the screen (it's off or locked)";
        StringBuilder sb = new StringBuilder();
        for (AccessibilityNodeInfo root : rs) {
            boolean kb = isKeyboard(root);
            sb.append(kb ? "── keyboard open (" : "── window: ").append(Actions.label(this, root.getPackageName()))
              .append(kb ? ") — use enter to submit, or tap its keys" : "").append('\n');
            if (!kb) walk(root, sb, 0, max, false);
            else walkKeys(root, sb, max);
        }
        if (sb.length() > max) sb.setLength(max);
        return sb.toString().trim();
    }

    /** Keyboard: only the action keys matter (letters are typed with type). */
    private static void walkKeys(AccessibilityNodeInfo root, StringBuilder sb, int max) {
        ArrayDeque<AccessibilityNodeInfo> q = new ArrayDeque<>();
        q.add(root);
        for (int seen = 0; !q.isEmpty() && seen < 400 && sb.length() < max; seen++) {
            AccessibilityNodeInfo n = q.poll();
            String t = label(n);
            if (t.length() > 1 && n.isVisibleToUser() && t.matches("(?i)go|search|enter|done|send|next|delete|backspace|shift|space|.*emoji.*")) {
                sb.append("[key] ").append(t).append(at(n)).append('\n');
            }
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo ch = n.getChild(i);
                if (ch != null) q.add(ch);
            }
        }
    }

    private static String at(AccessibilityNodeInfo n) {
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        return " @" + b.centerX() + "," + b.centerY();
    }

    private static void walk(AccessibilityNodeInfo n, StringBuilder sb, int depth, int max, boolean inClickable) {
        if (n == null || depth > 40 || sb.length() > max) return;
        boolean click = inClickable || n.isClickable();
        String t = label(n);
        if (n.isVisibleToUser()) {
            if (n.isEditable()) {
                CharSequence hint = n.getHintText();
                sb.append(n.isFocused() ? "[field, focused] " : "[field] ")
                  .append(t.isEmpty() && hint != null ? "(" + hint + ")" : clip(t)).append(at(n)).append('\n');
            } else if (!t.isEmpty()) {
                sb.append(click ? "[tap] " : "").append(clip(t)).append(click ? at(n) : "").append('\n');
            }
        }
        boolean passDown = click && t.isEmpty();
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), sb, depth + 1, max, passDown);
    }

    private static String clip(String t) {
        t = t.replace('\n', ' ');
        return t.length() > 120 ? t.substring(0, 120) + "…" : t;
    }
}
