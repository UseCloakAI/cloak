package org.usecloak.agent;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

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

    /** First visible node whose label is exactly one of the phrases (case-insensitive). */
    AccessibilityNodeInfo findExact(String... phrases) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        for (String p : phrases) {
            for (AccessibilityNodeInfo n : root.findAccessibilityNodeInfosByText(p)) {
                if (n.isVisibleToUser() && label(n).equalsIgnoreCase(p)) return n;
            }
        }
        return null;
    }

    /** Exact label match first, then the first visible partial match. */
    AccessibilityNodeInfo find(String text) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || text.isEmpty()) return null;
        List<AccessibilityNodeInfo> hits = root.findAccessibilityNodeInfosByText(text);
        AccessibilityNodeInfo partial = null;
        for (AccessibilityNodeInfo n : hits) {
            if (!n.isVisibleToUser()) continue;
            if (label(n).equalsIgnoreCase(text)) return n;
            if (partial == null) partial = n;
        }
        return partial;
    }

    boolean click(AccessibilityNodeInfo n) {
        for (AccessibilityNodeInfo x = n; x != null; x = x.getParent()) {
            if (x.isClickable() && x.isEnabled()) return x.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        }
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        Path p = new Path();
        p.moveTo(b.centerX(), b.centerY());
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, 60)).build();
        return dispatchGesture(g, null, null);
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

    String dump(int max) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "can't read the screen (it's off or locked)";
        StringBuilder sb = new StringBuilder("app: ").append(Actions.label(this, root.getPackageName())).append('\n');
        walk(root, sb, 0, max, false);
        if (sb.length() > max) sb.setLength(max);
        return sb.toString().trim();
    }

    private static void walk(AccessibilityNodeInfo n, StringBuilder sb, int depth, int max, boolean inClickable) {
        if (n == null || depth > 40 || sb.length() > max) return;
        boolean click = inClickable || n.isClickable();
        String t = label(n);
        if (n.isVisibleToUser()) {
            if (n.isEditable()) {
                CharSequence hint = n.getHintText();
                sb.append("[field] ").append(t.isEmpty() && hint != null ? "(" + hint + ")" : clip(t)).append('\n');
            } else if (!t.isEmpty()) {
                sb.append(click ? "[tap] " : "").append(clip(t)).append('\n');
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
