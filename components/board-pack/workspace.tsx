"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Download, Eye, FilePlus2, History, ImageOff, LockKeyhole, Printer, RefreshCw } from "lucide-react";
import { workspaceTabIdentity } from "@/lib/community/workspace-fetch";
import type { BoardPackCaptureInput, BoardPackDesk, BoardPackReport, BoardPackSourceDetail, BoardPackSummary, BoardPackView } from "@/lib/reports/board-pack-contracts";
import { BoardPackDocument } from "./document";
import { BoardPackDialog, BoardPackEntry, BoardPackNotice, BoardPackRequestError, BoardPackShell, boardPackDate, boardPackFetch, boardPackLabel, boardPackRequest, loadBoardPackReviewedImage, type BoardPackImageView } from "./shared";

type Busy = "capture" | "refresh" | "read" | "history" | "print" | "preview" | "export" | null;
type PrintPreparation = { phase: "decode" | "ready"; action: "print" | "preview"; reportId: string; contentHash: string; scope: string; paper: "A4" | "Letter"; packageId: string | null; checkedAt: string };
type Blocked = "expired" | "changed" | "access" | null;
type RequestBoundary = { signal: AbortSignal; current: () => boolean; finish: () => void; cancel: () => void };
type GalleryCache = { key: string; images: Record<string, BoardPackImageView>; pending: Map<string, { promise: Promise<BoardPackImageView>; active: () => boolean }> };
const accessChanged = (error: unknown) => error instanceof BoardPackRequestError && ([401, 403].includes(error.status) || ["BOARD_PACK_SCOPE_CHANGED", "BOARD_PACK_CONTEXT_CHANGED", "WORKSPACE_CONTEXT_CHANGED"].includes(error.code));
const messageFor = (error: unknown) => error instanceof BoardPackRequestError ? error.message : "The connection did not finish. Check the saved report before trying again.";
const abortError = (error: unknown) => error instanceof Error && error.name === "AbortError";
const summaryMatches = (view: BoardPackView, projectId: string, role: BoardPackDesk["audience"]["role"], reportId?: string) => view.summary.role === role && (!reportId || view.summary.id === reportId) && (!view.report || (view.report.id === view.summary.id && view.report.contentHash === view.summary.contentHash && view.report.project.id === projectId && view.report.audience.role === role));

export function BoardPackWorkspace({ initial }: { initial: BoardPackDesk }) {
  const [desk, setDesk] = useState<BoardPackDesk | null>({ ...initial, selected: null });
  const [view, setView] = useState<BoardPackView | null>(initial.selected), [busy, setBusy] = useState<Busy>(null), [blocked, setBlocked] = useState<Blocked>(null);
  const [message, setMessage] = useState<string | null>(null), [error, setError] = useState(false), [paused, setPaused] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const [label, setLabel] = useState("Project Board Pack"), [uncertainCapture, setUncertainCapture] = useState(false);
  const [packageId, setPackageId] = useState<string | null>(null), [paper, setPaper] = useState<"A4" | "Letter">("A4"), [printPreparation, setPrintPreparation] = useState<PrintPreparation | null>(null);
  const [sourceTrail, setSourceTrail] = useState<string[]>([]), [detail, setDetail] = useState<BoardPackSourceDetail | null>(null), [detailError, setDetailError] = useState<string | null>(null), [detailLoading, setDetailLoading] = useState(false), [sourceReload, setSourceReload] = useState(0);
  const [preview, setPreview] = useState<string | null>(null), [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState<string | null>(null);
  const [images, setImages] = useState<Record<string, BoardPackImageView>>({}), [galleryRevision, setGalleryRevision] = useState(0);
  const gallery = useRef<GalleryCache | null>(null), galleryEpoch = useRef(0);
  const epoch = useRef(0), controllers = useRef(new Set<AbortController>()), reviewSequence = useRef(0), mutationEpoch = useRef(0), sourceSequence = useRef(0), imageSequence = useRef(0);
  const busyRef = useRef<Busy>(busy), blockedRef = useRef<Blocked>(blocked), selectedRef = useRef<BoardPackView | null>(view), requestedReport = useRef<string | null>(initial.selected?.summary.id ?? null), previewUrl = useRef<string | null>(null);
  const captureAttempt = useRef<BoardPackCaptureInput | null>(null);
  const printPreparationRef = useRef<PrintPreparation | null>(printPreparation), previewHeading = useRef<HTMLHeadingElement>(null), prepareButton = useRef<HTMLButtonElement>(null);
  printPreparationRef.current = printPreparation;
  const printReady = printPreparation?.phase === "ready" && printPreparation.scope === initial.scope && printPreparation.reportId === view?.summary.id && printPreparation.contentHash === view?.summary.contentHash && printPreparation.paper === paper && printPreparation.packageId === packageId && !!view?.report && !!view.canPrint && view.status !== "withdrawn" && !paused && !blocked;
  busyRef.current = busy; blockedRef.current = blocked; selectedRef.current = view;
  const setBusyNow = useCallback((value: Busy) => { busyRef.current = value; setBusy(value); }, []);

  const invalidate = useCallback(() => { epoch.current++; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); }, []);
  const start = useCallback((): RequestBoundary => { const controller = new AbortController(), current = epoch.current; controllers.current.add(controller); return { signal: controller.signal, current: () => !controller.signal.aborted && current === epoch.current, finish: () => controllers.current.delete(controller), cancel: () => { controller.abort(); controllers.current.delete(controller); } }; }, []);
  const clearGallery = useCallback(() => { galleryEpoch.current++; for (const image of Object.values(gallery.current?.images ?? {})) if (image.url) URL.revokeObjectURL(image.url); gallery.current = null; setImages({}); }, []);
  const clearPreview = useCallback(() => { imageSequence.current++; if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = null; setPreview(null); setPreviewBusy(false); setPreviewError(null); }, []);
  const closeSource = useCallback(() => { sourceSequence.current++; setSourceTrail([]); setDetail(null); setDetailError(null); setDetailLoading(false); clearPreview(); }, [clearPreview]);
  const stopAccess = useCallback((reason: Exclude<Blocked, null>) => {
    invalidate(); mutationEpoch.current++; captureAttempt.current = null; requestedReport.current = null; setUncertainCapture(false); closeSource(); clearGallery(); setView(null); setDesk(null); setBlocked(reason); blockedRef.current = reason; setBusyNow(null); setPrintPreparation(null); setPaused(false); setMessage(null);
  }, [clearGallery, closeSource, invalidate, setBusyNow]);
  const requireLivePage = useCallback(() => {
    if (blockedRef.current) return false;
    if (Date.parse(initial.sessionExpiresAt) <= Date.now()) { stopAccess("expired"); return false; }
    return true;
  }, [initial.sessionExpiresAt, stopAccess]);
  const checkDesk = useCallback((next: BoardPackDesk) => {
    if (next.scope !== initial.scope || next.projectId !== initial.projectId || next.audience.role !== initial.audience.role) throw new BoardPackRequestError("Your active workspace or role changed. Open it again from saved workspaces.", "BOARD_PACK_SCOPE_CHANGED", 409);
  }, [initial.audience.role, initial.projectId, initial.scope]);
  const checkView = useCallback((next: BoardPackView, id?: string) => {
    if (!summaryMatches(next, initial.projectId, initial.audience.role, id)) throw new BoardPackRequestError("This response belongs to a different report context. Reopen the report from its history.", "BOARD_PACK_SCOPE_CHANGED", 409);
    return next;
  }, [initial.audience.role, initial.projectId]);

  const ensureImages = useCallback(async (report: BoardPackReport, request: RequestBoundary, sourceIds?: Set<string>) => {
    const key = `${report.id}:${report.contentHash}`;
    if (gallery.current?.key !== key) { clearGallery(); gallery.current = { key, images: {}, pending: new Map() }; }
    const cache = gallery.current!, generation = galleryEpoch.current;
    const active = () => request.current() && generation === galleryEpoch.current && gallery.current === cache && !blockedRef.current && Date.parse(initial.sessionExpiresAt) > Date.now();
    const descriptors = report.reviewedImages.filter(image => !sourceIds || sourceIds.has(image.sourceId));
    const results = await Promise.allSettled(descriptors.map(image => {
      const saved = cache.images[image.sourceId];
      if (saved?.state === "ready" && saved.contentHash === image.contentHash && saved.url) return Promise.resolve(saved);
      const pending = cache.pending.get(image.sourceId); if (pending?.active()) return pending.promise;
      if (saved?.url) URL.revokeObjectURL(saved.url);
      const loading: BoardPackImageView = { state: "loading", contentHash: image.contentHash, url: null, error: null };
      cache.images[image.sourceId] = loading; if (active()) setImages({ ...cache.images });
      const promise: Promise<BoardPackImageView> = loadBoardPackReviewedImage(report, image, { scope: initial.scope, signal: request.signal }).then(blob => {
        if (!active()) throw new DOMException("Report context changed", "AbortError");
        const ready: BoardPackImageView = { state: "ready", contentHash: image.contentHash, url: URL.createObjectURL(blob), error: null };
        const previous = cache.images[image.sourceId]?.url; if (previous) URL.revokeObjectURL(previous);
        cache.images[image.sourceId] = ready; setImages({ ...cache.images }); return ready;
      }).catch(caught => {
        if (active() && !abortError(caught)) {
          if (accessChanged(caught)) stopAccess("access");
          else if (caught instanceof BoardPackRequestError && caught.status === 410) { clearGallery(); closeSource(); setView(null); setPaused(true); setPrintPreparation(null); setMessage(messageFor(caught)); setError(true); }
          else { cache.images[image.sourceId] = { state: "error", contentHash: image.contentHash, url: null, error: messageFor(caught) }; setImages({ ...cache.images }); }
        }
        throw caught;
      }).finally(() => { if (cache.pending.get(image.sourceId)?.promise === promise) cache.pending.delete(image.sourceId); });
      cache.pending.set(image.sourceId, { promise, active }); return promise;
    }));
    return results;
  }, [clearGallery, closeSource, initial.scope, initial.sessionExpiresAt, stopAccess]);

  const reviewedImageFailed = useCallback((id: string) => {
    const cache = gallery.current, image = cache?.images[id]; if (!cache || !image) return;
    if (image.url) URL.revokeObjectURL(image.url);
    cache.images[id] = { state: "error", contentHash: image.contentHash, url: null, error: "The reviewed image could not be displayed. Check its source again." }; setImages({ ...cache.images });
    setPrintPreparation(null); if (busyRef.current === "print" || busyRef.current === "preview") setBusyNow(null); setMessage("A reviewed image could not be displayed. Check the images before printing this edition."); setError(true);
  }, [setBusyNow]);

  const refresh = useCallback(async (quiet = false) => {
    if (!requireLivePage() || (quiet && busyRef.current)) return;
    const request = start(), sequence = ++reviewSequence.current, mutation = mutationEpoch.current, id = requestedReport.current;
    const hadPreparedPreview = printPreparationRef.current?.phase === "ready";
    if (!quiet) { setBusyNow("refresh"); setMessage(null); }
    try {
      const [nextDesk, selected] = await Promise.all([
        boardPackRequest<{ desk: BoardPackDesk }>("", { scope: initial.scope, signal: request.signal }),
        id ? boardPackRequest<{ view: BoardPackView }>(`/${encodeURIComponent(id)}`, { scope: initial.scope, signal: request.signal }) : Promise.resolve(null),
      ]);
      if (!request.current() || sequence !== reviewSequence.current || mutation !== mutationEpoch.current || !requireLivePage()) return;
      checkDesk(nextDesk.desk);
      const nextView = selected ? checkView(selected.view, id!) : nextDesk.desk.selected ? checkView(nextDesk.desk.selected) : null;
      setDesk(current => {
        if (!quiet || !current) return { ...nextDesk.desk, selected: null };
        return { ...nextDesk.desk, selected: null, history: [...nextDesk.desk.history, ...current.history.filter(item => !nextDesk.desk.history.some(saved => saved.id === item.id))], nextCursor: current.history.length ? current.nextCursor : nextDesk.desk.nextCursor };
      });
      setView(nextView); requestedReport.current = nextView?.summary.id ?? null; setPaused(false); setNeedsRefresh(false); setPrintPreparation(null);
      if (nextView?.status === "withdrawn") { closeSource(); clearGallery(); }
      if (!quiet) { setMessage("Report access and saved history checked."); setError(false); }
      else if (hadPreparedPreview) { setMessage("Access was checked again. Prepare the print preview again before printing this edition."); setError(false); }
    } catch (caught) {
      if (!request.current() || sequence !== reviewSequence.current || mutation !== mutationEpoch.current || abortError(caught)) return;
      if (accessChanged(caught)) { stopAccess("access"); return; }
      // A failed current-access check pauses disclosure until a successful retry.
      setView(null); setPaused(true); setPrintPreparation(null); closeSource(); clearGallery(); setMessage(messageFor(caught)); setError(true);
    } finally { if (request.current() && sequence === reviewSequence.current && !quiet) setBusyNow(null); request.finish(); }
  }, [checkDesk, checkView, clearGallery, closeSource, initial.scope, requireLivePage, setBusyNow, start, stopAccess]);

  const galleryReportId = view?.status === "withdrawn" ? null : view?.report?.id;
  const galleryReportHash = view?.status === "withdrawn" ? null : view?.report?.contentHash;
  useEffect(() => {
    const selected = selectedRef.current;
    if (!selected?.report || selected.status === "withdrawn" || selected.report.id !== galleryReportId || selected.report.contentHash !== galleryReportHash) { clearGallery(); return; }
    const request = start();
    void ensureImages(selected.report, request).then(results => {
      if (!request.current()) return;
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected" && !abortError(result.reason));
      if (failures.length && gallery.current) { setMessage("Some reviewed images could not be opened. Check them again before printing this edition."); setError(true); }
    }).finally(() => request.finish());
    return () => request.cancel();
  }, [clearGallery, ensureImages, galleryReportHash, galleryReportId, galleryRevision, start]);

  useEffect(() => {
    const remaining = Date.parse(initial.sessionExpiresAt) - Date.now();
    if (remaining <= 0) { stopAccess("expired"); return; }
    const timer = window.setTimeout(() => stopAccess("expired"), Math.min(remaining, 2_147_483_647));
    const channel = new BroadcastChannel("fieldproof-workspace-changed");
    channel.onmessage = event => { if (event.data?.origin !== workspaceTabIdentity()) stopAccess("changed"); };
    return () => { window.clearTimeout(timer); channel.close(); invalidate(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); galleryEpoch.current++; for (const image of Object.values(gallery.current?.images ?? {})) if (image.url) URL.revokeObjectURL(image.url); gallery.current = null; };
  }, [initial.sessionExpiresAt, invalidate, stopAccess]);
  useEffect(() => {
    const check = () => { if (document.visibilityState === "visible") void refresh(true); };
    const interval = window.setInterval(check, 30_000);
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [refresh]);
  useEffect(() => {
    const prepared = printPreparationRef.current;
    if (prepared && (prepared.scope !== initial.scope || prepared.packageId !== packageId || prepared.paper !== paper || prepared.reportId !== view?.summary.id || prepared.contentHash !== view?.summary.contentHash)) {
      setPrintPreparation(null);
      if (prepared.phase === "ready") { setMessage("The print selection changed. Prepare this edition again before printing."); setError(false); }
    }
  }, [initial.scope, packageId, paper, view?.summary.contentHash, view?.summary.id]);
  useEffect(() => { if (printReady && printPreparation?.action === "preview") previewHeading.current?.focus({ preventScroll: true }); }, [printReady, printPreparation?.action]);
  useEffect(() => {
    const after = () => { setPrintPreparation(null); setBusyNow(null); setMessage("The browser print view has closed. Your saved edition remains at its cutoff."); setError(false); };
    window.addEventListener("afterprint", after);
    return () => window.removeEventListener("afterprint", after);
  }, [setBusyNow]);

  async function selectReport(summary: BoardPackSummary) {
    if (!requireLivePage() || busyRef.current) return;
    invalidate(); mutationEpoch.current++; reviewSequence.current++; const request = start();
    requestedReport.current = summary.id; closeSource(); clearGallery(); setView(null); setBusyNow("read"); setPrintPreparation(null); setMessage(null); setPaused(false); setPackageId(null);
    try {
      const next = await boardPackRequest<{ view: BoardPackView }>(`/${encodeURIComponent(summary.id)}`, { scope: initial.scope, signal: request.signal });
      if (!request.current() || !requireLivePage()) return;
      setView(checkView(next.view, summary.id));
    } catch (caught) {
      if (!request.current() || abortError(caught)) return;
      if (accessChanged(caught)) { stopAccess("access"); return; }
      setPaused(true); setMessage(messageFor(caught)); setError(true);
    } finally { if (request.current()) setBusyNow(null); request.finish(); }
  }
  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!desk?.canCapture || !requireLivePage() || busyRef.current || needsRefresh) return;
    invalidate(); mutationEpoch.current++; reviewSequence.current++; closeSource(); const request = start();
    const attempt = captureAttempt.current ?? { intentId: crypto.randomUUID(), label: label.trim(), expectedProjectionVersion: desk.projectionVersion };
    captureAttempt.current = attempt; setBusyNow("capture"); setMessage(null); setPrintPreparation(null);
    try {
      const next = await boardPackRequest<{ view: BoardPackView }>("/capture", { scope: initial.scope, signal: request.signal, body: attempt });
      if (!request.current() || !requireLivePage()) return;
      const accepted = checkView(next.view);
      captureAttempt.current = null; setUncertainCapture(false); setView(accepted); requestedReport.current = accepted.summary.id; setPackageId(null); setPaused(false);
      setDesk(current => current ? { ...current, projectionVersion: accepted.currentProjectionVersion, eventCursor: accepted.currentEventCursor, history: [accepted.summary, ...current.history.filter(item => item.id !== accepted.summary.id)] } : current);
      setMessage(accepted.status === "withdrawn" ? "The report was saved, but a bound source needs a new review." : "Your dated Board Pack is saved. Its facts stay at this cutoff."); setError(false);
    } catch (caught) {
      if (!request.current()) return;
      if (accessChanged(caught)) { stopAccess("access"); return; }
      if (caught instanceof BoardPackRequestError && caught.code === "BOARD_PACK_CAPTURE_BUSY") setUncertainCapture(true);
      else if (caught instanceof BoardPackRequestError && [400, 409].includes(caught.status)) { captureAttempt.current = null; setUncertainCapture(false); setNeedsRefresh(caught.status === 409); }
      else setUncertainCapture(true);
      setMessage(messageFor(caught)); setError(true);
    } finally { if (request.current()) { setBusyNow(null); setGalleryRevision(current => current + 1); } request.finish(); }
  }
  async function loadOlder() {
    if (!desk?.nextCursor || !requireLivePage() || busyRef.current) return;
    mutationEpoch.current++; const request = start(); setBusyNow("history"); setMessage(null);
    try {
      const next = await boardPackRequest<{ desk: BoardPackDesk }>(`?before=${encodeURIComponent(desk.nextCursor)}`, { scope: initial.scope, signal: request.signal });
      if (!request.current() || !requireLivePage()) return;
      checkDesk(next.desk);
      setDesk(current => current ? { ...current, history: [...current.history, ...next.desk.history.filter(item => !current.history.some(saved => saved.id === item.id))], nextCursor: next.desk.nextCursor } : current);
    } catch (caught) { if (!request.current() || abortError(caught)) return; if (accessChanged(caught)) stopAccess("access"); else { setMessage(messageFor(caught)); setError(true); } }
    finally { if (request.current()) setBusyNow(null); request.finish(); }
  }
  const printOrExport = useCallback(async (kind: "print" | "preview" | "export") => {
    const current = selectedRef.current;
    if (!current || !requireLivePage() || busyRef.current || paused) return;
    const id = current.summary.id, contentHash = current.summary.contentHash; mutationEpoch.current++; reviewSequence.current++; const request = start(); let queuedPreparation = false;
    closeSource(); setBusyNow(kind); setMessage(null); setPrintPreparation(null);
    try {
      const checked = await boardPackRequest<{ view: BoardPackView }>(`/${encodeURIComponent(id)}`, { scope: initial.scope, signal: request.signal });
      if (!request.current() || !requireLivePage()) return;
      const next = checkView(checked.view, id);
      if (next.summary.contentHash !== contentHash) throw new BoardPackRequestError("This response does not match the selected immutable edition. Reopen it from saved history.", "BOARD_PACK_EDITION_CHANGED", 409);
      setView(next);
      if (!next.report || next.status === "withdrawn" || !(kind === "export" ? next.canExport : next.canPrint)) { setMessage("This edition is no longer available for that action. Create a fresh report after reviewing its current sources."); setError(true); return; }
      if (kind !== "export") {
        const selectedImages = new Set(next.report.reviewedImages.filter(image => { const source = next.report!.sources.find(item => item.id === image.sourceId); return source && (!packageId || !source.packageIds.length || source.packageIds.includes(packageId)); }).map(image => image.sourceId));
        if (selectedImages.size) { setMessage(`Preparing ${selectedImages.size} reviewed ${selectedImages.size === 1 ? "image" : "images"} for printing…`); setError(false); }
        const loaded = await ensureImages(next.report, request, selectedImages);
        if (!request.current() || !requireLivePage()) return;
        const failed = loaded.find((result): result is PromiseRejectedResult => result.status === "rejected"); if (failed) throw failed.reason;
        await document.fonts.ready;
        if (!request.current() || !requireLivePage()) return;
        queuedPreparation = true;
        setPrintPreparation({ phase: "decode", action: kind, reportId: id, contentHash, scope: initial.scope, paper, packageId, checkedAt: next.checkedAt });
        // The rendered image decode and final current-access check happen before
        // either path can expose the printable state. Preview never opens OS print.
      } else {
        const response = await boardPackFetch(`/${encodeURIComponent(id)}/export`, { scope: initial.scope, signal: request.signal }), blob = await response.blob();
        if (!request.current() || !requireLivePage()) return;
        const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `fieldproof-board-pack-${id.slice(0, 8)}.csv`; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
        setMessage("The CSV contains all sections in this edition’s audience scope. The on-screen package filter does not reduce that export."); setError(false);
      }
    } catch (caught) {
      if (!request.current() || abortError(caught)) return;
      if (accessChanged(caught)) { stopAccess("access"); return; }
      setView(null); setPaused(true); setMessage(messageFor(caught)); setError(true); closeSource(); clearGallery();
    } finally { if (request.current() && !queuedPreparation) setBusyNow(null); request.finish(); }
  }, [checkView, clearGallery, closeSource, ensureImages, initial.scope, packageId, paper, paused, requireLivePage, setBusyNow, start, stopAccess]);
  useEffect(() => {
    const pending = printPreparation;
    if (pending?.phase !== "decode" || !view?.canPrint || !view.report || view.status === "withdrawn" || blocked) return;
    const request = start(); let stage: "images" | "access" = "images", ready = false;
    const nodes = Array.from(document.querySelectorAll<HTMLImageElement>(".bp-report img[data-bp-reviewed-image]"));
    void (async () => {
      try {
        const expected = view.report!.reviewedImages.filter(image => { const source = view.report!.sources.find(item => item.id === image.sourceId); return source && (!pending.packageId || !source.packageIds.length || source.packageIds.includes(pending.packageId)); });
        if (nodes.length !== expected.length || nodes.some(node => !expected.some(image => image.sourceId === node.dataset.bpReviewedImage))) throw new Error("The rendered image set changed.");
        await Promise.all(nodes.map(image => image.decode()));
        await document.fonts.ready;
        if (!request.current() || !requireLivePage()) return;
        stage = "access";
        const final = await boardPackRequest<{ view: BoardPackView }>(`/${encodeURIComponent(pending.reportId)}`, { scope: initial.scope, signal: request.signal });
        if (!request.current() || !requireLivePage()) return;
        const finalView = checkView(final.view, pending.reportId);
        if (finalView.summary.contentHash !== pending.contentHash) throw new BoardPackRequestError("This response does not match the selected immutable edition. Reopen it from saved history.", "BOARD_PACK_EDITION_CHANGED", 409);
        setView(finalView);
        if (!finalView.report || finalView.status === "withdrawn" || !finalView.canPrint) { setPrintPreparation(null); clearGallery(); setMessage("This edition changed access while print was being prepared. Review its current state before printing."); setError(true); return; }
        if (nodes.some(image => !image.isConnected) || pending.scope !== initial.scope || pending.paper !== paper || pending.packageId !== packageId || selectedRef.current?.summary.id !== pending.reportId || selectedRef.current?.summary.contentHash !== pending.contentHash) {
          setPrintPreparation(null); setMessage("The report view changed while printing was being prepared. Prepare this edition again."); setError(false); return;
        }
        ready = true; setPrintPreparation({ ...pending, phase: "ready", checkedAt: finalView.checkedAt }); setError(false);
        if (pending.action === "preview") { setBusyNow(null); setMessage(null); }
      } catch (caught) {
        if (!request.current() || abortError(caught)) return;
        setPrintPreparation(null);
        if (stage === "images") {
          for (const image of nodes) if (!image.complete || !image.naturalWidth) { const sourceId = image.dataset.bpReviewedImage; if (sourceId) reviewedImageFailed(sourceId); }
          setMessage("A reviewed image could not be decoded for printing. Check the images and try again."); setError(true);
        } else if (accessChanged(caught)) stopAccess("access");
        else { setView(null); setPaused(true); setMessage(messageFor(caught)); setError(true); closeSource(); clearGallery(); }
      } finally { if (request.current() && !ready) setBusyNow(null); request.finish(); }
    })();
    return () => request.cancel();
  }, [blocked, checkView, clearGallery, closeSource, initial.scope, packageId, paper, printPreparation, requireLivePage, reviewedImageFailed, setBusyNow, start, stopAccess, view]);
  useEffect(() => {
    if (!printReady || printPreparation?.action !== "print") return;
    const prepared = printPreparation;
    const frame = requestAnimationFrame(() => {
      if (printPreparationRef.current !== prepared || !requireLivePage()) return;
      try { window.print(); } finally { setPrintPreparation(null); setBusyNow(null); }
    });
    return () => cancelAnimationFrame(frame);
  }, [printPreparation, printReady, requireLivePage, setBusyNow]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p" && !event.altKey) { event.preventDefault(); void printOrExport("print"); } };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, [printOrExport]);

  const sourceId = sourceTrail.at(-1) ?? null;
  const sourceReportId = view?.status === "withdrawn" ? null : view?.report?.id;
  const sourceReportHash = view?.status === "withdrawn" ? null : view?.report?.contentHash;
  useEffect(() => {
    if (!sourceId || !sourceReportId || !sourceReportHash || blocked) return;
    const reportId = sourceReportId, request = start(), sequence = ++sourceSequence.current;
    setDetail(null); setDetailError(null); setDetailLoading(true); clearPreview();
    void boardPackRequest<{ detail: BoardPackSourceDetail }>(`/${encodeURIComponent(reportId)}/sources/${encodeURIComponent(sourceId)}`, { scope: initial.scope, signal: request.signal }).then(next => {
      if (!request.current() || sequence !== sourceSequence.current || !requireLivePage()) return;
      if (next.detail.reportId !== reportId || next.detail.contentHash !== sourceReportHash || next.detail.source.id !== sourceId) throw new BoardPackRequestError("This source response no longer matches the selected edition. Reopen the report.", "BOARD_PACK_SCOPE_CHANGED", 409);
      setDetail(next.detail);
    }).catch(caught => {
      if (!request.current() || sequence !== sourceSequence.current || abortError(caught)) return;
      if (accessChanged(caught)) { stopAccess("access"); return; }
      setDetailError(messageFor(caught)); if (caught instanceof BoardPackRequestError && [409, 410].includes(caught.status)) void refresh(true);
    }).finally(() => { if (request.current() && sequence === sourceSequence.current) setDetailLoading(false); request.finish(); });
    return () => { sourceSequence.current++; request.cancel(); };
  }, [blocked, clearPreview, initial.scope, refresh, requireLivePage, sourceId, sourceReload, sourceReportHash, sourceReportId, start, stopAccess]);

  function navigateSource(id: string, direction: "root" | "related" | "back") {
    if (id === sourceId || !requireLivePage()) return;
    sourceSequence.current++; clearPreview(); setDetail(null); setDetailError(null); setDetailLoading(true);
    setSourceTrail(current => direction === "root" ? [id] : direction === "back" ? current.slice(0, -1) : [...current, id]);
  }

  async function openPreview() {
    if (!detail?.image || !requireLivePage() || previewBusy) return;
    const image = detail.image, request = start(), sequence = ++imageSequence.current;
    setPreviewBusy(true); setPreviewError(null);
    try {
      const parsed = new URL(image.url, window.location.origin);
      if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith(`/api/board-packs/${encodeURIComponent(detail.reportId)}/`)) throw new Error("Source image route is outside the selected report.");
      const response = await boardPackFetch(parsed.pathname.slice("/api/board-packs".length) + parsed.search, { scope: initial.scope, signal: request.signal }), blob = await response.blob();
      if (!request.current() || sequence !== imageSequence.current || !requireLivePage()) return;
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); const url = URL.createObjectURL(blob); previewUrl.current = url; setPreview(url);
    } catch (caught) {
      if (!request.current() || sequence !== imageSequence.current || abortError(caught)) return;
      if (accessChanged(caught)) { stopAccess("access"); return; }
      setPreviewError("This source image could not be opened with current access. Recheck the source record.");
      if (caught instanceof BoardPackRequestError && [409, 410].includes(caught.status)) void refresh(true);
    } finally { if (request.current() && sequence === imageSequence.current) setPreviewBusy(false); request.finish(); }
  }


  if (blocked || !desk) return <BoardPackShell><BoardPackEntry recovery title={blocked === "expired" ? "Your report session has ended." : blocked === "changed" ? "Your active workspace changed." : "This report needs current access."}><p>{blocked === "expired" ? "The original access deadline has passed. Private report content is cleared from this view." : "Private report content is cleared. Reopen your current project and role from saved workspaces."}</p></BoardPackEntry></BoardPackShell>;
  const hasReport = Boolean(view?.report && view.status !== "withdrawn" && !paused), source = view?.report?.sources.find(item => item.id === sourceId);
  return <BoardPackShell projectTitle={desk.projectTitle} audience={desk.audience.label}>
    <style>{`@media print { @page { size: ${paper}; margin: 13mm; } }`}</style>
    <div className={`bp-print-container${printReady && printPreparation?.action === "preview" ? " is-prepared-preview" : ""}`} data-paper={paper} data-print-ready={printReady && hasReport ? "true" : "false"}>
      <div className="bp-print-warning"><h1>Recheck this edition before printing.</h1><p>Use “Prepare print preview” or “Print / save PDF” to check current access, reviewed images and the selected paper size. Private report content is omitted from an unchecked print.</p></div>
      <div className="bp-workspace-heading"><div><p className="bp-kicker">A SHARED PICTURE. A CLEAR RECORD.</p><h1>The Board Pack<span>.</span></h1><p>One dated account of support, expenses and the evidence behind the work.</p></div><div className="bp-heading-seal" aria-hidden="true"><FilePlus2 size={30} strokeWidth={1.1}/><span>PREPARED<br/>WITH CARE</span></div></div>
      <div className="bp-workspace-layout"><aside className="bp-controls" aria-label="Report editions and actions">
        {desk.canCapture && <form className="bp-capture" onSubmit={event => void capture(event)}><div className="bp-control-heading"><FilePlus2 size={20}/><h2>Make a dated edition.</h2></div><p>Save the facts available to your current role. Later changes leave this cutoff intact.</p><label htmlFor="bp-capture-label">Edition name<input id="bp-capture-label" value={label} maxLength={100} required readOnly={uncertainCapture} disabled={Boolean(busy)} onChange={event => { setLabel(event.target.value); captureAttempt.current = null; }}/></label><button type="submit" className="bp-button bp-primary" disabled={Boolean(busy) || needsRefresh || !label.trim()}>{busy === "capture" ? <RefreshCw className="bp-spin" size={16}/> : <FilePlus2 size={16}/>}{busy === "capture" ? "Saving the cutoff…" : uncertainCapture ? "Retry same capture" : "Capture current report"}</button>{uncertainCapture && <p className="bp-control-note">The response was interrupted. Retry keeps the original request and cutoff attempt.</p>}{needsRefresh && <p className="bp-control-note">The project changed. Refresh its current version before starting another edition.</p>}<span className="bp-control-version">Current project v{desk.projectionVersion} · event {desk.eventCursor}</span></form>}
        <section className="bp-history" aria-labelledby="bp-history-title"><div className="bp-control-heading"><History size={20}/><h2 id="bp-history-title">Your saved editions</h2></div><p>{desk.audience.label}. Other actors and roles keep separate report histories.</p>{desk.history.length ? <ol>{desk.history.map(summary => <li key={summary.id}><button type="button" aria-current={view?.summary.id === summary.id ? "true" : undefined} disabled={Boolean(busy)} onClick={() => void selectReport(summary)}><span><strong>{summary.label}</strong><time dateTime={summary.asOf}>{boardPackDate(summary.asOf)}</time><small>v{summary.projectionVersion} · {summary.packageCount} packages</small></span>{view?.summary.id === summary.id ? <Check size={16}/> : <ArrowUpRight size={15}/>}</button></li>)}</ol> : <p className="bp-history-empty">No report has been saved for this project role yet.</p>}{desk.nextCursor && <button type="button" className="bp-button bp-secondary" disabled={Boolean(busy)} onClick={() => void loadOlder()}>{busy === "history" ? "Loading older editions…" : "Load older editions"}<ChevronDown size={15}/></button>}</section>
        <div className="bp-session-note"><LockKeyhole size={15}/><p>Private access ends {boardPackDate(desk.sessionExpiresAt)}. Returning here does not extend that deadline.</p></div>
      </aside>
      <div className="bp-report-column">
        <div className="bp-toolbar"><button type="button" className="bp-button bp-secondary" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={16} className={busy === "refresh" ? "bp-spin" : undefined}/>{busy === "refresh" ? "Checking access…" : "Refresh access"}</button><label>Paper size<select value={paper} onChange={event => setPaper(event.target.value as "A4" | "Letter")} disabled={Boolean(busy)}><option value="A4">A4</option><option value="Letter">Letter</option></select></label><button type="button" className="bp-button bp-secondary" disabled={Boolean(busy) || !hasReport || !view?.canExport} onClick={() => void printOrExport("export")}><Download size={16}/>{busy === "export" ? "Preparing CSV…" : "Full scoped CSV"}</button><button ref={prepareButton} type="button" className="bp-button bp-secondary" disabled={(Boolean(busy) && busy !== "preview") || !hasReport || !view?.canPrint} aria-disabled={Boolean(busy) || !hasReport || !view?.canPrint} aria-busy={busy === "preview"} onClick={() => void printOrExport("preview")}><Eye size={16}/>{busy === "preview" ? "Preparing preview…" : "Prepare print preview"}</button><button type="button" className="bp-button bp-primary" disabled={(Boolean(busy) && busy !== "print") || !hasReport || !view?.canPrint} aria-disabled={Boolean(busy) || !hasReport || !view?.canPrint} aria-busy={busy === "print"} onClick={() => void printOrExport("print")}><Printer size={16}/>{busy === "print" ? "Checking edition…" : "Print / save PDF"}</button></div>
        {printReady && printPreparation?.action === "preview" && <section className="bp-print-preview" aria-label="Prepared print preview"><p className="bp-kicker">THE SAME SAVED EDITION · READY FOR PRINT</p><h2 ref={previewHeading} tabIndex={-1}>Your {paper} print preview is ready.</h2><p>Current access and reviewed images have been checked. This preview uses the saved edition below and your selected paper size.</p><dl><div><dt>Edition</dt><dd><code>{printPreparation.reportId}</code></dd></div><div><dt>Detail selection</dt><dd>{packageId ? view?.report?.packages.find(item => item.packageId === packageId)?.title ?? "Selected purpose" : "All permitted purposes"}</dd></div><div><dt>Content SHA-256</dt><dd><code>{printPreparation.contentHash}</code></dd></div><div><dt>Access checked</dt><dd>{boardPackDate(printPreparation.checkedAt)}</dd></div></dl><p className="bp-control-note">Changing the edition, paper or purpose selection requires another check. A later access check also clears this prepared state.</p><button type="button" className="bp-button bp-secondary" onClick={() => { setPrintPreparation(null); setMessage("Print preview closed. Prepare this edition again before printing."); setError(false); prepareButton.current?.focus({ preventScroll: true }); }}><ArrowLeft size={16}/>Return to Board Pack</button></section>}
        {message && <div className={`bp-action-message${error ? " is-error" : ""}`} role={error ? "alert" : "status"}><p>{message}</p></div>}
        {busy === "read" && <div className="bp-report-loading" role="status"><RefreshCw size={24} className="bp-spin"/><h2>Opening the selected edition.</h2><p>Checking your current role and its bound sources.</p></div>}
        {paused && <BoardPackNotice title="Private content is paused until access can be checked." error><p>Refresh access to reopen this edition. Its saved identity remains in your history.</p></BoardPackNotice>}
        {view && !paused && busy !== "read" && <BoardPackDocument view={view} packageId={packageId} onPackageChange={busy ? undefined : id => { setPackageId(id); setPrintPreparation(null); if (printPreparationRef.current?.phase === "ready") { setMessage("The print selection changed. Prepare this edition again before printing."); setError(false); } }} onSource={busy ? undefined : id => navigateSource(id, "root")} images={images} onImageError={reviewedImageFailed} onRetryImages={busy ? undefined : () => setGalleryRevision(current => current + 1)}/>}
        {!view && !paused && busy !== "read" && <section className="bp-no-report"><FilePlus2 size={44} strokeWidth={1}/><p className="bp-kicker">YOUR PROJECT, ON THE RECORD</p><h2>A place for the whole picture.</h2><p>{desk.canCapture ? "Capture a dated report to bring together the plan, current funding, repayments and reviewed evidence available to your role." : "A current project role is needed to prepare a private report. Open an existing edition if one is available to this role."}</p><div><span>01 · A declared cutoff</span><span>02 · Source-linked facts</span><span>03 · A4 or Letter</span></div></section>}
      </div></div>
    </div>
    {sourceId && <BoardPackDialog title={detail?.source.label ?? source?.label ?? "Checking the report source"} focusKey={sourceId} close={closeSource}><SourcePanel detail={detail} loading={detailLoading} error={detailError} preview={preview} previewBusy={previewBusy} previewError={previewError} onPreview={preview ? clearPreview : () => void openPreview()} onRetry={() => { sourceSequence.current++; clearPreview(); setDetail(null); setDetailError(null); setDetailLoading(true); setSourceReload(current => current + 1); }} onImageError={() => { clearPreview(); setPreviewError("The source image could not be displayed. Recheck its current source permissions."); }} onRelated={id => navigateSource(id, "related")} onBack={sourceTrail.length > 1 ? () => navigateSource(sourceTrail[sourceTrail.length - 2], "back") : undefined} close={closeSource}/></BoardPackDialog>}
  </BoardPackShell>;
}

export function SourcePanel({ detail, loading, error, preview, previewBusy, previewError, onPreview, onImageError, onRelated, onBack, onRetry, close }: {
  detail: BoardPackSourceDetail | null; loading: boolean; error: string | null; preview: string | null; previewBusy: boolean; previewError: string | null;
  onPreview: () => void; onImageError: () => void; onRelated: (id: string) => void; onBack?: () => void; onRetry?: () => void; close: () => void;
}) {
  return <><div className="bp-source-navigation">{onBack && <button type="button" className="bp-text-button" onClick={onBack}><ArrowLeft size={15}/>Previous source</button>}<button type="button" className="bp-text-button" onClick={close}><ArrowLeft size={15}/>Go back to report</button></div>{loading && <p className="bp-source-loading" role="status"><RefreshCw size={19} className="bp-spin"/>Checking this source against current access…</p>}{error && <BoardPackNotice title="This source is not available." error><p>{error}</p>{onRetry && <button type="button" className="bp-button bp-secondary" onClick={onRetry}><RefreshCw size={15}/>Check source again</button>}</BoardPackNotice>}{detail && !error && !loading && <><div className="bp-source-cutoff"><LockKeyhole size={16}/><p>Bound to the report captured {boardPackDate(detail.asOf)}.<br/><span>{boardPackLabel(detail.source.provenance)} · {detail.source.scope}</span></p></div><dl className="bp-detail-fields">{detail.fields.map((field, index) => <div key={`${field.label}-${index}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>{detail.image && <div className="bp-source-image"><button type="button" className="bp-button bp-secondary" aria-disabled={previewBusy} aria-busy={previewBusy} onClick={() => { if (!previewBusy) onPreview(); }}><Eye size={16}/>{previewBusy ? "Checking image access…" : preview ? "Close source image" : "Inspect source image"}</button>{preview && <figure><img src={preview} width={detail.image.width} height={detail.image.height} alt={detail.image.alt} onError={onImageError}/><figcaption>{detail.image.alt}<code>Image SHA-256 {detail.image.contentHash}</code></figcaption></figure>}{previewError && <p className="bp-image-error" role="alert"><ImageOff size={18}/>{previewError}</p>}</div>}{detail.limitations.length > 0 && <ul className="bp-source-limitations">{detail.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>}{detail.relatedSourceIds.length > 0 && <div className="bp-related-sources"><h3>Follow the source links</h3>{detail.relatedSourceIds.map(id => <button type="button" className="bp-text-button" key={id} onClick={() => onRelated(id)}>{id}<ArrowUpRight size={14}/></button>)}</div>}<div className="bp-source-hash"><span>Report content hash</span><code>{detail.contentHash}</code></div></>}</>;
}
