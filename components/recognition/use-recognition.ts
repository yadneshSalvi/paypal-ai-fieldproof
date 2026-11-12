"use client";

import { useEffect, useRef, useState } from "react";
import { workspaceTabIdentity } from "@/lib/community/workspace-fetch";
import { recognitionDeskSchema, recognitionModerationPageSchema, recognitionReceiptSchema, recognitionReviewSchema,
  type RecognitionCommand, type RecognitionDesk, type RecognitionJournal, type RecognitionModerationPage, type RecognitionReview } from "@/lib/recognition/contracts";
import { clearRecognitionJournal, readRecognitionJournal, recognitionFetch, RecognitionRequestError, writeRecognitionJournal } from "@/lib/recognition/client";

export function useRecognition(initialSlug?: string) {
  const [desk, setDesk] = useState<RecognitionDesk | null>(null), [moderation, setModeration] = useState<RecognitionModerationPage | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [loading, setLoading] = useState(true), [working, setWorking] = useState(false), [refreshing, setRefreshing] = useState(false), [fresh, setFresh] = useState(false);
  const [journal, setJournal] = useState<RecognitionJournal | null>(null), [review, setReview] = useState<{ input: RecognitionCommand; preview: RecognitionReview } | null>(null);
  const [checkedIntent, setCheckedIntent] = useState<string | null>(null), [obsolete, setObsolete] = useState(false), [resetKey, setResetKey] = useState(0), [storageReady, setStorageReady] = useState(true);
  const epoch = useRef(0), controllers = useRef(new Set<AbortController>()), view = useRef<RecognitionDesk | null>(null), reading = useRef(false), acting = useRef(false), selected = useRef(initialSlug), cursor = useRef<string | undefined>(undefined);
  const pending = useRef<RecognitionJournal | null>(null), checked = useRef<string | null>(null), recoveryStarted = useRef<string | null>(null);
  function start(timeoutMs = 4_000) {
    const controller = new AbortController(), version = epoch.current; controllers.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return { signal: controller.signal, current: () => epoch.current === version,
      finish: () => { clearTimeout(timeout); controllers.current.delete(controller); } };
  }
  function invalidate(message: string) {
    epoch.current++; controllers.current.forEach(item => item.abort()); controllers.current.clear(); reading.current = false; acting.current = false;
    view.current = null; pending.current = null; checked.current = null; recoveryStarted.current = null;
    setDesk(null); setModeration(null); setReview(null); setJournal(null); setCheckedIntent(null); setFresh(false); setLoading(false); setWorking(false); setRefreshing(false); setNotice(""); setError(message); setResetKey(value => value + 1);
  }
  function withhold(message: string) {
    setFresh(false); setReview(null); setModeration(null); setError(message);
    if (view.current) { const safe = { ...view.current, own: view.current.own ? { ...view.current.own, label: null } : null }; view.current = safe; setDesk(safe); }
  }
  async function load() {
    if (reading.current || acting.current || document.visibilityState === "hidden") return;
    reading.current = true; setRefreshing(true); const task = start(), original = view.current;
    try {
      const next = await recognitionFetch(`/api/recognition${selected.current ? `?slug=${selected.current}` : ""}`, recognitionDeskSchema, { accessId: original?.access.accessId, signal: task.signal });
      if (!task.current()) return;
      if (original && original.access.accessId !== next.access.accessId) { invalidate("The active project profile changed. Private names and drafts were cleared. Reload your current profile."); return; }
      const oldTarget = original?.targets.find(item => item.slug === original.selectedSlug), target = next.targets.find(item => item.slug === next.selectedSlug);
      if (original && (original.own?.version !== next.own?.version || oldTarget?.reviewKey !== target?.reviewKey)) { setReview(null); setResetKey(value => value + 1); }
      view.current = next; selected.current = next.selectedSlug ?? undefined; setDesk(next); setFresh(true); setError("");
      if (!original) {
        try { const saved = readRecognitionJournal(sessionStorage, next.access.accessId); pending.current = saved; setJournal(saved); setStorageReady(true); }
        catch { setStorageReady(false); setError("This browser could not verify its private request journal. No new decision can be sent; enable session storage and reload."); }
      }
      if (next.kind === "organizer" && next.selectedSlug) {
        const page = await recognitionFetch(`/api/recognition/moderation/${next.selectedSlug}${cursor.current ? `?cursor=${encodeURIComponent(cursor.current)}` : ""}`, recognitionModerationPageSchema, { accessId: next.access.accessId, signal: task.signal });
        if (!task.current()) return;
        if (page.access.accessId !== next.access.accessId || Date.parse(page.validUntil) <= Date.now()) throw new Error("This permission check expired before it arrived.");
        setModeration(page);
      }
    } catch (failure) {
      if (!task.current()) return;
      if (failure instanceof RecognitionRequestError && [403, 410].includes(failure.status) || failure instanceof RecognitionRequestError && failure.code === "RECOGNITION_CONTEXT_CHANGED")
        invalidate(failure.message);
      else withhold(failure instanceof RecognitionRequestError ? failure.message : "The current choice could not be checked. Public labels stay hidden until you reload its status.");
    } finally { task.finish(); if (task.current()) { reading.current = false; setRefreshing(false); setLoading(false); } }
  }
  async function checkOriginal() {
    const current = view.current, saved = pending.current;
    if (!current || !saved || acting.current || reading.current || document.visibilityState === "hidden" || saved.accessId !== current.access.accessId) return;
    acting.current = true; setWorking(true); setError(""); const task = start();
    try {
      await recognitionFetch(`/api/recognition/commands/${saved.input.intentId}`, recognitionReceiptSchema, { accessId: saved.accessId, signal: task.signal });
      if (!task.current()) return;
      clearRecognitionJournal(sessionStorage, saved.accessId); pending.current = null; setJournal(null); checked.current = saved.input.intentId; setCheckedIntent(saved.input.intentId);
      setNotice("The original decision has a saved receipt. Its current visibility is checked separately."); setReview(null); setResetKey(value => value + 1);
    } catch (failure) {
      if (!task.current()) return;
      if (failure instanceof RecognitionRequestError && failure.code === "RECOGNITION_COMMAND_NOT_FOUND" && failure.status === 404) {
        const confirmed = { ...saved, state: "not_received" as const }; writeRecognitionJournal(sessionStorage, confirmed); pending.current = confirmed; setJournal(confirmed);
        checked.current = saved.input.intentId; setCheckedIntent(saved.input.intentId); setNotice("No accepted receipt was found for this exact original request. Review it before an explicit retry.");
      } else if (failure instanceof RecognitionRequestError && ([403, 410].includes(failure.status) || failure.code === "RECOGNITION_CONTEXT_CHANGED")) invalidate(failure.message);
      else setError(failure instanceof RecognitionRequestError ? failure.message : "The original result is still unknown. Check it again; nothing was replayed.");
    } finally { task.finish(); if (task.current()) { acting.current = false; setWorking(false); void load(); } }
  }
  async function preview(input: RecognitionCommand) {
    const current = view.current;
    if (!current || !fresh || reading.current || acting.current || !storageReady || input.accessId !== current.access.accessId) return;
    if (pending.current && (pending.current.input.intentId !== input.intentId || checked.current !== input.intentId || pending.current.state !== "not_received")) return;
    acting.current = true; setWorking(true); setError(""); setObsolete(false); const task = start();
    try {
      const result = await recognitionFetch("/api/recognition/review", recognitionReviewSchema, { input, signal: task.signal });
      if (!task.current()) return;
      if (result.intentId !== input.intentId || result.action !== input.action || Date.parse(result.validUntil) <= Date.now()) throw new Error();
      setReview({ input, preview: result });
    } catch (failure) {
      if (!task.current()) return;
      if (failure instanceof RecognitionRequestError && ([403, 410].includes(failure.status) || failure.code === "RECOGNITION_CONTEXT_CHANGED")) invalidate(failure.message);
      else { setError(failure instanceof RecognitionRequestError ? failure.message : "This exact preview could not be checked. No decision was sent.");
        if (pending.current?.state === "not_received" && failure instanceof RecognitionRequestError && ["RECOGNITION_VERSION_CHANGED", "RECOGNITION_SOURCE_CHANGED", "RECOGNITION_ALREADY_PRIVATE", "RECOGNITION_LABEL_UNAVAILABLE"].includes(failure.code)) setObsolete(true); }
    } finally { task.finish(); if (task.current()) { acting.current = false; setWorking(false); } }
  }
  async function confirm() {
    const current = view.current, held = review;
    if (!current || !held || !fresh || acting.current || reading.current || held.input.accessId !== current.access.accessId || Date.parse(held.preview.validUntil) <= Date.now()) return;
    const saved: RecognitionJournal = { accessId: held.input.accessId, input: held.input, state: "unresolved" };
    try { writeRecognitionJournal(sessionStorage, saved); } catch { setError("This browser could not retain the original request. No decision was sent."); setStorageReady(false); return; }
    pending.current = saved; checked.current = null; recoveryStarted.current = null; setJournal(saved); setCheckedIntent(null);
    acting.current = true; setWorking(true); setError(""); const task = start(8_000);
    try {
      const result = await recognitionFetch("/api/recognition/commands", recognitionReceiptSchema, { input: held.input, signal: task.signal });
      if (!task.current()) return;
      if (result.intentId !== held.input.intentId || result.action !== held.input.action) throw new Error();
      clearRecognitionJournal(sessionStorage, held.input.accessId); pending.current = null; setJournal(null); setNotice("Your decision was saved. We are checking its current visibility."); setReview(null); setResetKey(value => value + 1);
    } catch (failure) {
      if (!task.current()) return;
      if (failure instanceof RecognitionRequestError && ([403, 410].includes(failure.status) || failure.code === "RECOGNITION_CONTEXT_CHANGED")) invalidate(failure.message);
      else { setReview(null); setError(failure instanceof RecognitionRequestError ? failure.message : "The response was missing. Its original result is unknown; check the retained request before retrying."); }
    } finally { task.finish(); if (task.current()) { acting.current = false; setWorking(false); void load(); } }
  }
  async function closeObsolete() {
    const saved = pending.current;
    if (!saved || !obsolete || checked.current !== saved.input.intentId || saved.state !== "not_received" || acting.current || reading.current) return;
    acting.current = true; setWorking(true); const task = start();
    try {
      await recognitionFetch(`/api/recognition/commands/${saved.input.intentId}`, recognitionReceiptSchema, { accessId: saved.accessId, signal: task.signal });
      if (task.current()) setNotice("An accepted original receipt was found. Check the original request to finish recovery.");
    } catch (failure) {
      if (!task.current()) return;
      if (failure instanceof RecognitionRequestError && failure.status === 404 && failure.code === "RECOGNITION_COMMAND_NOT_FOUND") {
        clearRecognitionJournal(sessionStorage, saved.accessId); pending.current = null; setJournal(null); setObsolete(false); setError(""); setNotice("The unaccepted, outdated request was closed. Make a separate current decision."); setResetKey(value => value + 1);
      } else setError("The original result could not be checked. Its request was retained.");
    } finally { task.finish(); if (task.current()) { acting.current = false; setWorking(false); void load(); } }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (view.current) void load(); }, 4_000);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("fieldproof-workspace-changed");
    if (channel) channel.onmessage = event => { if (event.data?.origin !== workspaceTabIdentity()) invalidate("Another tab changed the active project profile. Private names and drafts were cleared. Reload your current profile."); };
    const visibility = () => { if (document.visibilityState === "hidden") {
      epoch.current++; controllers.current.forEach(item => item.abort()); controllers.current.clear(); reading.current = false; acting.current = false; setWorking(false); setRefreshing(false);
      withhold("This private view was hidden. Check its current choices when you return.");
    } else if (view.current) void load(); };
    const hide = () => invalidate("This private view was left. Reload its current original access before continuing.");
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", hide);
    return () => { epoch.current++; controllers.current.forEach(item => item.abort()); controllers.current.clear(); reading.current = false; acting.current = false; clearInterval(timer); channel?.close(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", hide); };
    // The effect owns one transport lifetime; refs contain all live scope data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!desk || !fresh) return;
    const deadline = Math.min(Date.parse(desk.access.validUntil), Date.parse(desk.observedAt) + 5_000, moderation ? Date.parse(moderation.validUntil) : Infinity);
    const timer = setTimeout(() => {
      if (Date.now() >= Date.parse(desk.access.validUntil)) invalidate("Your original recognition access has ended. Its deadline was not extended.");
      else withhold("Checking current permission. Labels stay hidden until the next current read.");
    }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [desk, moderation, fresh]);
  useEffect(() => {
    if (!journal || !desk || working || loading || document.visibilityState === "hidden" || recoveryStarted.current === journal.input.intentId) return;
    recoveryStarted.current = journal.input.intentId; void checkOriginal();
    // A remount checks once; only an explicit button can check it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal, desk?.access.accessId, working, loading]);
  function reload() { invalidate(""); selected.current = initialSlug; cursor.current = undefined; setLoading(true); void load(); }
  function select(slug: string) { if (acting.current || pending.current) return; selected.current = slug; cursor.current = undefined; setReview(null); setModeration(null); setResetKey(value => value + 1); void load(); }
  function page(nextCursor?: string) { if (acting.current || pending.current) return; cursor.current = nextCursor; setModeration(null); void load(); }
  return { desk, moderation, error, notice, loading, working, refreshing, fresh, journal, review, checkedIntent, obsolete, resetKey, storageReady,
    reload, refresh: load, select, page, preview, confirm, checkOriginal, closeObsolete, closeReview: () => { if (!acting.current) setReview(null); } };
}
