import { lstat, mkdir, open, readFile, realpath, link, unlink } from "node:fs/promises";
import path from "node:path";
import { digest, hash, OperationsError, requireOperation, type ArtifactAbsence, type ArtifactRecord, type ArtifactStore } from "./contracts";
import type { ArtifactNeed } from "./private-lineage";

const normalizeType = (value: string) => value.split(";")[0].trim().toLowerCase();
function artifactError(error: unknown, code: "ARTIFACT_MISSING" | "ARTIFACT_CONFLICT"): never {
  if (error instanceof OperationsError) throw error;
  throw new OperationsError(code, "An original private artifact could not be verified at its exact location.");
}
export async function captureArtifacts(needs: readonly ArtifactNeed[], store: ArtifactStore): Promise<{ artifacts: ArtifactRecord[]; absentArtifacts: ArtifactAbsence[] }> {
  const artifacts: ArtifactRecord[] = [], absentArtifacts: ArtifactAbsence[] = []; let total = 0;
  for (const need of needs) {
    let read: Awaited<ReturnType<ArtifactStore["read"]>>;
    try { read = await store.read(need.key); }
    catch (error) {
      if (error instanceof OperationsError && error.code === "ARTIFACT_MISSING" && need.absence) { absentArtifacts.push({ ...need.absence, bindings: need.bindings }); continue; }
      artifactError(error, "ARTIFACT_MISSING");
    }
    total += read.bytes.byteLength;
    requireOperation(total <= 128 * 1024 * 1024, "UNSUPPORTED_COVERAGE", "The artifact set exceeds the reviewed private transfer size; no artifact was omitted.");
    requireOperation(hash(read.bytes) === need.hash && (need.size === null || read.bytes.byteLength === need.size) && normalizeType(read.contentType) === need.contentType, "ARTIFACT_CONFLICT", "An original artifact differs from its recorded bytes, content type or hash.");
    artifacts.push({ key: need.key, hash: need.hash, size: read.bytes.byteLength, contentType: need.contentType, bindings: need.bindings, bytes: Buffer.from(read.bytes).toString("base64") });
  }
  return { artifacts, absentArtifacts };
}
export async function verifyArtifacts(artifacts: readonly ArtifactRecord[], absent: readonly ArtifactAbsence[], store: ArtifactStore): Promise<void> {
  for (const artifact of artifacts) {
    requireOperation(hash(Buffer.from(artifact.bytes, "base64")) === artifact.hash && Buffer.from(artifact.bytes, "base64").byteLength === artifact.size, "INVALID_BUNDLE", "A private artifact bundle has changed.");
    await store.verify(artifact.key, artifact.hash, artifact.size, artifact.contentType);
  }
  for (const missing of absent) {
    let present = false;
    try { await store.read(missing.key); present = true; }
    catch (error) { if (!(error instanceof OperationsError && error.code === "ARTIFACT_MISSING")) artifactError(error, "ARTIFACT_CONFLICT"); }
    requireOperation(!present, "ARTIFACT_CONFLICT", "An original pending upload location changed since review.");
  }
}
export async function stageArtifacts(artifacts: readonly ArtifactRecord[], absent: readonly ArtifactAbsence[], store: ArtifactStore, bundleId: string): Promise<void> {
  for (const artifact of artifacts) {
    const bytes = Buffer.from(artifact.bytes, "base64");
    requireOperation(bytes.byteLength === artifact.size && hash(bytes) === artifact.hash, "INVALID_BUNDLE", "An original artifact byte sequence has changed.");
    await store.stage(artifact.key, bytes, artifact.contentType, bundleId);
  }
  await verifyArtifacts(artifacts, absent, store);
}
/** Planning performs no writes, including when bytes need to be staged later. */
export async function inspectDestinationArtifacts(artifacts: readonly ArtifactRecord[], absent: readonly ArtifactAbsence[], store: ArtifactStore): Promise<void> {
  for (const artifact of artifacts) {
    try { await store.verify(artifact.key, artifact.hash, artifact.size, artifact.contentType); }
    catch (error) { if (!(error instanceof OperationsError && error.code === "ARTIFACT_MISSING")) artifactError(error, "ARTIFACT_CONFLICT"); }
  }
  await verifyArtifacts([], absent, store);
}
async function privateDirectory(directory: string, create: boolean): Promise<void> {
  if (create) await mkdir(directory, { mode: 0o700 });
  const stat = await lstat(directory);
  requireOperation(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700, "INVALID_CONFIGURATION", "Use only private 0700 directories without symlinks.");
}
/** Offline private-backup adapter. A deployed application's actual object-store
 * adapter must verify the same original keys; filesystem qualification does not
 * claim that an unrelated Blob account can serve these files. */
export async function privateFileArtifacts(directory: string, namespace: string): Promise<ArtifactStore> {
  requireOperation(path.isAbsolute(directory) && namespace.length >= 8 && namespace.length <= 160, "INVALID_CONFIGURATION", "Artifact adapters require an absolute private root and an explicit namespace binding.");
  await privateDirectory(directory, false);
  requireOperation(await realpath(directory) === path.resolve(directory), "INVALID_CONFIGURATION", "The artifact root must not traverse a symlink.");
  const location = async (key: string, create: boolean) => {
    requireOperation(/^fieldproof\/[a-f0-9-]{36}\/[a-zA-Z0-9_./-]+$/.test(key) && !key.includes("..") && !key.includes("//"), "ARTIFACT_CONFLICT", "Use the exact original private artifact key.");
    const components = key.split("/"); let current = directory;
    for (const component of components.slice(0, -1)) {
      current = path.join(current, component);
      try { await privateDirectory(current, false); }
      catch (error) {
        if (create && typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") await privateDirectory(current, true);
        else throw error;
      }
    }
    return path.join(directory, key);
  };
  const metadataPath = (key: string) => path.join(directory, `.artifact-${hash(key)}.json`);
  const read = async (key: string) => {
    try {
      const filename = await location(key, false);
      let stat: Awaited<ReturnType<typeof lstat>>;
      try { stat = await lstat(filename); }
      catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") throw new OperationsError("ARTIFACT_MISSING", "The original private artifact is absent at its recorded location."); throw error; }
      let metaStat: Awaited<ReturnType<typeof lstat>>;
      try { metaStat = await lstat(metadataPath(key)); }
      catch { throw new OperationsError("ARTIFACT_CONFLICT", "An existing private artifact has no original immutable location manifest."); }
      requireOperation(stat.isFile() && metaStat.isFile() && !stat.isSymbolicLink() && !metaStat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && (metaStat.mode & 0o777) === 0o600 && stat.size <= 25 * 1024 * 1024, "ARTIFACT_CONFLICT", "Private artifacts require original bounded files with 0600 permissions.");
      const [bytes, text] = await Promise.all([readFile(filename), readFile(metadataPath(key), "utf8")]), meta = JSON.parse(text);
      requireOperation(meta.format === "fieldproof-artifact-stage/v2" && meta.key === key && meta.hash === hash(bytes) && meta.size === bytes.length && typeof meta.contentType === "string", "ARTIFACT_CONFLICT", "The private artifact manifest and original bytes disagree.");
      return { bytes, contentType: meta.contentType as string };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") throw new OperationsError("ARTIFACT_MISSING", "The original private artifact is absent at its recorded location.");
      artifactError(error, "ARTIFACT_CONFLICT");
    }
  };
  return { namespace, binding: digest({ kind: "private-files", directory, namespace }), kind: "private-files", read,
    async verify(key, expectedHash, size, contentType) { const value = await read(key); requireOperation(hash(value.bytes) === expectedHash && value.bytes.length === size && normalizeType(value.contentType) === contentType, "ARTIFACT_CONFLICT", "The destination cannot serve the exact original private artifact bytes and content type."); },
    async stage(key, bytes, contentType, bundleId) {
      requireOperation(/^[a-f0-9-]{36}$/.test(bundleId), "INVALID_BUNDLE", "An artifact stage must retain its original reviewed import identity.");
      const filename = await location(key, true), meta = { format: "fieldproof-artifact-stage/v2", key, hash: hash(bytes), size: bytes.byteLength, contentType: normalizeType(contentType), bundleId };
      try { await lstat(filename); try { await lstat(metadataPath(key)); } catch { throw new OperationsError("ARTIFACT_CONFLICT", "An unknown existing private artifact cannot be adopted by a new import."); } }
      catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
      // The immutable metadata is also a crash journal. A retry can complete its
      // own missing file, but may not adopt another import's incomplete write.
      try { const file = await open(metadataPath(key), "wx", 0o600); try { await file.writeFile(JSON.stringify(meta)); await file.sync(); } finally { await file.close(); } }
      catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) artifactError(error, "ARTIFACT_CONFLICT");
        const stat = await lstat(metadataPath(key)); requireOperation(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600, "ARTIFACT_CONFLICT", "The original private artifact stage is not private.");
        const prior = JSON.parse(await readFile(metadataPath(key), "utf8"));
        requireOperation(prior.key === key && prior.hash === meta.hash && prior.size === meta.size && prior.contentType === meta.contentType, "ARTIFACT_CONFLICT", "The destination artifact key conflicts with another original byte sequence.");
        try { await read(key); return; } catch (readError) { requireOperation(readError instanceof OperationsError && readError.code === "ARTIFACT_MISSING" && prior.bundleId === bundleId, "ARTIFACT_CONFLICT", "Only the original reviewed import may finish an interrupted artifact stage."); }
      }
      const temporary = path.join(directory, `.stage-${bundleId}-${hash(key)}`);
      let file: Awaited<ReturnType<typeof open>>;
      try { file = await open(temporary, "wx", 0o600); }
      catch (error) {
        requireOperation(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST", "ARTIFACT_CONFLICT", "An owned private artifact stage could not be opened.");
        const stat = await lstat(temporary); requireOperation(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600, "ARTIFACT_CONFLICT", "The original interrupted stage is not a private owned file.");
        // This exact bundle's immutable journal binds the temporary name and
        // expected bytes. Rewriting its own interrupted temporary is safe.
        const prior = JSON.parse(await readFile(metadataPath(key), "utf8"));
        requireOperation(prior.bundleId === bundleId && prior.hash === meta.hash && prior.size === meta.size, "ARTIFACT_CONFLICT", "A different import owns the interrupted private stage.");
        file = await open(temporary, "w", 0o600);
      }
      try {
        await file.writeFile(bytes); await file.sync(); await file.close();
        try { await link(temporary, filename); }
        catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
      } finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
      const original = await read(key); requireOperation(hash(original.bytes) === meta.hash && original.contentType === meta.contentType, "ARTIFACT_CONFLICT", "The destination artifact differs from the reviewed original.");
    },
  };
}
