#!/usr/bin/env python3
"""Measure the Fieldproof judge tour in a real browser.

    python3 scripts/judge-tour-measure.py https://paypal-ai-fieldproof.vercel.app
    python3 scripts/judge-tour-measure.py http://localhost:4102 --width 360 --height 740 --shots /tmp/judge-shots
    python3 scripts/judge-tour-measure.py http://localhost:4102 --keyboard

Opens /judge cold in a fresh browser profile (no cookies), starts the 60-second tour with
one click (or with the keyboard only), lets it play at its default pace and prints:

  * time-to-first-blueprint: from pressing start to the finished sketch-to-blueprint redraw;
  * total tour time: from pressing start to the end card;

both as the page measured them (performance.now in the browser, the number a judge sees on
the end card) and as this script timed them from outside. It exits non-zero when the tour
does not finish, when the page's own total is over 60 s, or when the story's numbers are
wrong. Each run creates one private Sample workspace; nothing else is written.

Requires Python Playwright (`pip install playwright`). It uses Playwright's Chromium when
installed and otherwise the system Chrome.
"""
import argparse, json, re, sys, time
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

CUES = [("beat-1", "sketch"), ("beat-1", "drawn"), ("beat-1", "source"), ("beat-1", "review"), ("beat-2", "capturing"), ("beat-2", "declined"), ("beat-2", "invoice"),
        ("beat-2", "settled"), ("beat-3", "lines"), ("beat-3", "duplicate"), ("beat-3", "approval"), ("beat-3", "repayment")]

def launch(playwright, channel):
    if channel:
        return playwright.chromium.launch(channel=channel)
    try:
        return playwright.chromium.launch()
    except Exception:
        return playwright.chromium.launch(channel="chrome")

def main():
    parser = argparse.ArgumentParser(description="Measure the Fieldproof judge tour.")
    parser.add_argument("base_url")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=800)
    parser.add_argument("--shots", help="directory for screenshots of each beat")
    parser.add_argument("--keyboard", action="store_true", help="start the tour with the keyboard only")
    parser.add_argument("--reduced-motion", action="store_true")
    parser.add_argument("--channel", help="browser channel, e.g. chrome")
    parser.add_argument("--json", action="store_true", help="print one JSON object only")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    problems, shots = [], []
    with sync_playwright() as playwright:
        browser = launch(playwright, args.channel)
        context = browser.new_context(viewport={"width": args.width, "height": args.height}, reduced_motion="reduce" if args.reduced_motion else "no-preference")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        opened = time.monotonic()
        page.goto(base + "/judge", wait_until="domcontentloaded", timeout=90000)
        start = page.get_by_test_id("start-tour")
        start.wait_for(state="visible", timeout=60000)
        page.wait_for_function("() => { const b = document.querySelector('[data-testid=start-tour]'); return b && !b.disabled && Object.keys(b).some(k => k.startsWith('__reactProps')); }", timeout=60000)
        cold_open = time.monotonic() - opened
        if args.shots:
            path = f"{args.shots}/judge-{args.width}-landing.png"; page.screenshot(path=path, full_page=True); shots.append(path)
        if args.keyboard:
            for _ in range(40):
                page.keyboard.press("Tab")
                if page.evaluate("() => document.activeElement?.getAttribute('data-testid')") == "start-tour":
                    break
            else:
                problems.append("The start button was not reachable with Tab.")
            clicked = time.monotonic(); page.keyboard.press("Enter")
        else:
            clicked = time.monotonic(); start.click()
        dialog = page.locator("dialog.jt-dialog")
        try:
            dialog.wait_for(state="visible", timeout=60000)
        except PlaywrightTimeout:
            print("The tour did not open.", file=sys.stderr); sys.exit(2)
        tour_open = time.monotonic() - clicked
        live = dialog.get_attribute("data-tour-live") == "true"
        outside_first = None
        try:
            page.wait_for_function("() => document.querySelector('dialog.jt-dialog')?.getAttribute('data-first-blueprint-ms')", timeout=30000)
            outside_first = time.monotonic() - clicked
        except PlaywrightTimeout:
            problems.append("The blueprint redraw was never reported.")
        seen = {}
        deadline = time.monotonic() + 120
        pending = list(CUES)
        while time.monotonic() < deadline:
            state, cue = dialog.get_attribute("data-tour-state"), dialog.get_attribute("data-tour-cue")
            if state == "end":
                break
            for wanted in list(pending):
                if (state, cue) == wanted:
                    pending.remove(wanted); seen[f"{state}:{cue}"] = round(time.monotonic() - clicked, 2)
                    if args.shots:
                        page.wait_for_timeout(650)
                        path = f"{args.shots}/judge-{args.width}-{state}-{cue}.png"; page.screenshot(path=path); shots.append(path)
            page.wait_for_timeout(60)
        else:
            print("The tour did not reach its end card within 120 s.", file=sys.stderr); sys.exit(2)
        outside_total = time.monotonic() - clicked
        page.get_by_test_id("tour-measured").wait_for(state="visible", timeout=10000)
        page.wait_for_function("() => document.querySelector('dialog.jt-dialog')?.getAttribute('data-total-ms')", timeout=10000)
        total_ms, first_ms = int(dialog.get_attribute("data-total-ms")), dialog.get_attribute("data-first-blueprint-ms")
        shown = page.get_by_test_id("tour-measured").inner_text().strip()
        end_text = dialog.inner_text()
        if args.shots:
            path = f"{args.shots}/judge-{args.width}-end.png"; page.screenshot(path=path); shots.append(path)
        if not re.search(r"Tour took [\d.]+ s on this device", shown): problems.append(f"Unexpected end-card wording: {shown!r}")
        if total_ms > 60000: problems.append(f"The page measured {total_ms} ms, over 60 s.")
        if "Live" in re.sub(r"Live sandbox|Live AI", "", end_text): problems.append('The end card shows a "Live" label.')
        for wanted in ("beat-1:drawn", "beat-2:declined", "beat-2:invoice", "beat-2:settled", "beat-3:duplicate", "beat-3:approval", "beat-3:repayment"):
            if wanted not in seen: problems.append(f"Beat cue {wanted} was not observed.")
        scenario = None
        if live:
            state = context.request.get(base + "/api/judge/state").json().get("scenario")
            snapshot = context.request.get(base + "/api/snapshot").json()
            electronics = next(item for item in snapshot["packages"] if item["id"] == "electronics")
            scenario = {"version": state and state["version"], "tourStep": snapshot["tourStep"], "electronicsCollectedMinor": electronics["collectedMinor"], "projectTargetMinor": snapshot["targetMinor"], "mode": snapshot["mode"]}
            if electronics["collectedMinor"] != 96000: problems.append(f"Electronics collected is {electronics['collectedMinor']}, expected 96000 after the tour.")
            if snapshot["targetMinor"] != 841000 or snapshot["mode"] != "sample": problems.append("The workspace is not the $8,410 Sample project.")
        if errors: problems.append(f"Page errors: {errors[:3]}")
        browser.close()
    result = {"baseUrl": base, "viewport": f"{args.width}x{args.height}", "start": "keyboard" if args.keyboard else "click", "reducedMotion": args.reduced_motion, "ownWorkspace": live,
              "coldOpenToReadySeconds": round(cold_open, 2), "clickToTourOpenSeconds": round(tour_open, 2),
              "timeToFirstBlueprintSeconds": {"page": None if not first_ms else round(int(first_ms) / 1000, 2), "outside": None if outside_first is None else round(outside_first, 2)},
              "totalTourSeconds": {"page": round(total_ms / 1000, 2), "outside": round(outside_total, 2)}, "endCard": shown, "cuesSeenAtSeconds": seen, "scenario": scenario, "screenshots": shots, "problems": problems}
    if args.json:
        print(json.dumps(result))
    else:
        print(f"Judge tour at {base} ({result['viewport']}, {result['start']} start{', reduced motion' if args.reduced_motion else ''})")
        print(f"  cold open to ready button:  {result['coldOpenToReadySeconds']} s")
        print(f"  time to first blueprint:    {result['timeToFirstBlueprintSeconds']['page']} s (page)   {result['timeToFirstBlueprintSeconds']['outside']} s (outside)")
        print(f"  total tour time:            {result['totalTourSeconds']['page']} s (page)   {result['totalTourSeconds']['outside']} s (outside)")
        print(f"  end card:                   {shown}")
        print(f"  own private workspace:      {live}" + (f"   {json.dumps(scenario)}" if scenario else ""))
        print(f"  cues seen at (s):           {json.dumps(seen)}")
        for path in shots: print(f"  screenshot: {path}")
        for problem in problems: print(f"  PROBLEM: {problem}")
    sys.exit(1 if problems else 0)

if __name__ == "__main__":
    main()
