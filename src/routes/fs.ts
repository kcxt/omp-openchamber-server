/** Filesystem endpoints: directory explorer, file read/write, project directory switch, and the OpenCode file lookups. */
import { readdir, mkdir, stat, rm, rename, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute, basename, extname } from "node:path";
import type { RouteContext } from "../http/router";
import { readJson } from "../http/response";
import { createProjectIdFromPath, findGitDirectories } from "../services/projects";
import { readOmpConfig, writeOmpConfig } from "../services/settings-file";

function resolveFsPath(rawPath: string, effectiveDir = process.cwd()): string {
  const home = Bun.env.HOME || process.env.HOME || "/tmp";
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
  if (isAbsolute(trimmed)) return trimmed;
  return join(effectiveDir, trimmed);
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ts": "text/plain; charset=utf-8",
};

export async function handleFs(ctx: RouteContext): Promise<Response | undefined> {
  const { req, url, path, p, effectiveDir, cors, json, jsonError } = ctx;
  // Directory Explorer (OpenChamber Add Project Dialog)
  if ((path === "/fs/list" || path === "/api/fs/list") && req.method === "GET") {
    const rawPath = url.searchParams.get("path")?.trim() || "";
    const targetDir = resolveFsPath(rawPath, effectiveDir);
    try {
      const dirents = await readdir(targetDir, { withFileTypes: true });
      const entries = dirents.map((d) => ({
        name: d.name,
        path: join(targetDir, d.name),
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
        isSymbolicLink: d.isSymbolicLink(),
      }));
      return json({
        path: targetDir,
        entries,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "fs list failed", 400);
    }
  }

  // Nested Git repository discovery used by the OpenChamber Git picker.
  if ((path === "/fs/git-dirs" || path === "/api/fs/git-dirs") && req.method === "GET") {
    const rawPath = url.searchParams.get("path")?.trim() || "";
    if (!rawPath) return jsonError("Path is required", 400);

    const targetDir = resolveFsPath(rawPath, effectiveDir);
    try {
      const s = await stat(targetDir);
      if (!s.isDirectory()) {
        return json({ error: "Specified path is not a directory", reason: "not-directory" }, { status: 400 });
      }

      const repositories = await findGitDirectories(targetDir);
      return json({
        path: targetDir,
        repositories: repositories.map((repositoryPath) => ({
          path: repositoryPath,
          name: basename(repositoryPath),
        })),
      });
    } catch (err: any) {
      if (err && err.code === "ENOENT") {
        return json({ error: "Directory not found", reason: "not-found" }, { status: 404 });
      }
      if (err && (err.code === "EACCES" || err.code === "EPERM")) {
        return jsonError("Access to directory denied", 403);
      }
      return jsonError(err instanceof Error ? err.message : "Failed to find git directories", 500);
    }
  }

  // Filesystem mkdir
  if ((path === "/fs/mkdir" || path === "/api/fs/mkdir") && req.method === "POST") {
    const body = (await readJson(req)) as { path?: string } | undefined;
    const target = body?.path?.trim();
    if (!target) return jsonError("Path is required", 400);
    const resolved = resolveFsPath(target, effectiveDir);
    try {
      await mkdir(resolved, { recursive: true });
      return json({ success: true, path: resolved });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "mkdir failed", 500);
    }
  }

  // OpenCode directory switch / create
  if ((path === "/opencode/directory" || path === "/api/opencode/directory") && req.method === "POST") {
    const body = (await readJson(req)) as { path?: string; create?: boolean } | undefined;
    const target = body?.path?.trim();
    if (!target) return jsonError("Path is required", 400);

    const resolved = resolveFsPath(target, effectiveDir);
    if (body?.create === true) {
      try {
        await mkdir(resolved, { recursive: true });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "Failed to create directory", 500);
      }
    }

    try {
      const s = await stat(resolved);
      if (!s.isDirectory()) {
        return jsonError("Specified path is not a directory", 400);
      }
    } catch {
      return jsonError("Directory does not exist", 400);
    }

    const currentSettings = readOmpConfig(effectiveDir);
    const existingProjects = Array.isArray(currentSettings.projects)
      ? [...(currentSettings.projects as Array<Record<string, unknown>>)]
      : [];

    const projectId = createProjectIdFromPath(resolved);
    const existingIndex = existingProjects.findIndex(
      (p) => p && typeof p === "object" && p.path === resolved
    );

    if (existingIndex >= 0) {
      existingProjects[existingIndex] = {
        ...existingProjects[existingIndex],
        lastOpenedAt: Date.now(),
      };
    } else {
      const label = basename(resolved) || resolved;
      existingProjects.push({
        id: projectId,
        path: resolved,
        label,
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
      });
    }

    const updatedSettings = writeOmpConfig({
      projects: existingProjects,
      activeProjectId: projectId,
      lastDirectory: resolved,
    });

    return json({
      success: true,
      restarted: false,
      path: resolved,
      settings: updatedSettings,
    });
  }

  // Filesystem read
  if ((path === "/fs/read" || path === "/api/fs/read") && req.method === "GET") {
    const rawPath = url.searchParams.get("path")?.trim() || "";
    const optional = url.searchParams.get("optional") === "true";
    if (!rawPath) return jsonError("Path is required", 400);
    const resolved = resolveFsPath(rawPath, effectiveDir);
    try {
      const s = await stat(resolved);
      if (!s.isFile()) {
        return jsonError("Specified path is not a file", 400);
      }
      const content = await Bun.file(resolved).text();
      return new Response(content, {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    } catch (err: any) {
      if (err && (err.code === "ENOENT" || String(err).includes("ENOENT"))) {
        if (optional) {
          return new Response("", {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "text/plain; charset=utf-8",
            },
          });
        }
        return jsonError("File not found", 404);
      }
      return jsonError(err instanceof Error ? err.message : "read failed", 500);
    }
  }

  // Filesystem raw
  if ((path === "/fs/raw" || path === "/api/fs/raw") && req.method === "GET") {
    const rawPath = url.searchParams.get("path")?.trim() || "";
    const optional = url.searchParams.get("optional") === "true";
    const download = url.searchParams.get("download") === "true";
    if (!rawPath) return jsonError("Path is required", 400);
    const resolved = resolveFsPath(rawPath, effectiveDir);
    try {
      const s = await stat(resolved);
      if (!s.isFile()) {
        return jsonError("Specified path is not a file", 400);
      }
      const ext = extname(resolved).toLowerCase();
      const mimeType = MIME_TYPES[ext] || "application/octet-stream";
      const headers: Record<string, string> = {
        ...cors,
        "Content-Type": mimeType,
        "Cache-Control": "no-store",
      };
      if (download) {
        const fileName = basename(resolved);
        const asciiOnly = fileName.replace(/[^\x00-\x7F]/g, "") || "file";
        const encoded = encodeURIComponent(fileName);
        headers["Content-Disposition"] = `attachment; filename="${asciiOnly}"; filename*=UTF-8''${encoded}`;
      }
      const file = Bun.file(resolved);
      return new Response(file, {
        status: 200,
        headers,
      });
    } catch (err: any) {
      if (err && (err.code === "ENOENT" || String(err).includes("ENOENT"))) {
        if (optional) {
          return new Response("", {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "application/octet-stream",
            },
          });
        }
        return jsonError("File not found", 404);
      }
      return jsonError(err instanceof Error ? err.message : "raw read failed", 500);
    }
  }

  // Filesystem serve (used by OpenChamber HTML preview / iframe)
  if ((path.startsWith("/api/fs/serve/") || path.startsWith("/fs/serve/")) && req.method === "GET") {
    const prefix = path.startsWith("/api/fs/serve/") ? "/api/fs/serve/" : "/fs/serve/";
    const rawSubpath = path.slice(prefix.length);
    if (!rawSubpath) return jsonError("Path is required", 400);
    const decodedPath = decodeURIComponent(rawSubpath);
    const candidatePath = decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`;
    const resolved = existsSync(candidatePath) ? candidatePath : resolveFsPath(decodedPath, effectiveDir);
    try {
      const s = await stat(resolved);
      if (!s.isFile()) {
        return jsonError("Specified path is not a file", 400);
      }
      const ext = extname(resolved).toLowerCase();
      const mimeType = MIME_TYPES[ext] || "application/octet-stream";
      const headers: Record<string, string> = {
        ...cors,
        "Content-Type": mimeType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      const file = Bun.file(resolved);
      return new Response(file, {
        status: 200,
        headers,
      });
    } catch (err: any) {
      if (err && (err.code === "ENOENT" || String(err).includes("ENOENT"))) {
        return jsonError("File not found", 404);
      }
      return jsonError(err instanceof Error ? err.message : "serve failed", 500);
    }
  }

  // Filesystem clone
  if ((path === "/fs/clone" || path === "/api/fs/clone") && req.method === "POST") {
    const body = (await readJson(req)) as { remoteUrl?: string; destinationPath?: string } | undefined;
    const remoteUrl = body?.remoteUrl?.trim();
    const destinationPath = body?.destinationPath?.trim();
    if (!remoteUrl) return jsonError("Repository URL is required", 400);
    if (!destinationPath) return jsonError("Destination path is required", 400);
    const resolved = resolveFsPath(destinationPath, effectiveDir);
    try {
      const proc = Bun.spawn(["git", "clone", "--", remoteUrl, resolved], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (exitCode !== 0) {
        return jsonError(stderr.trim() || stdout.trim() || `git clone failed with code ${exitCode}`, 500);
      }
      return json({ success: true, path: resolved });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "git clone failed", 500);
    }
  }

  // Filesystem reveal
  if ((path === "/fs/reveal" || path === "/api/fs/reveal") && req.method === "POST") {
    const body = (await readJson(req)) as { path?: string } | undefined;
    const target = body?.path?.trim();
    if (!target) return jsonError("Path is required", 400);
    const resolved = resolveFsPath(target, effectiveDir);
    try {
      if (process.platform === "darwin") {
        Bun.spawn(["open", "-R", resolved]);
      } else if (process.platform === "win32") {
        Bun.spawn(["explorer.exe", `/select,${resolved}`]);
      } else {
        Bun.spawn(["xdg-open", resolved]);
      }
      return json({ success: true, path: resolved });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "reveal failed", 500);
    }
  }

  // Filesystem stat
  if ((path === "/fs/stat" || path === "/api/fs/stat") && req.method === "GET") {
    const target = url.searchParams.get("path")?.trim();
    if (!target) return jsonError("Path is required", 400);
    const resolved = resolveFsPath(target, effectiveDir);
    try {
      const s = await stat(resolved);
      return json({
        exists: true,
        isDirectory: s.isDirectory(),
        isFile: s.isFile(),
        size: s.size,
        mtime: s.mtimeMs,
        path: resolved,
      });
    } catch {
      return json({ exists: false, isDirectory: false, isFile: false, size: 0, mtime: 0, path: resolved });
    }
  }

  // Directory availability batch (OpenChamber getDirectoryAvailability /
  // getDirectoryRealPaths). `reason` is what the client keys on to decide
  // between "missing" and "unknown", so it has to name the failure mode.
  if ((path === "/fs/directory-stats" || path === "/api/fs/directory-stats") && req.method === "POST") {
    const body = (await readJson(req)) as { paths?: unknown } | undefined;
    const requested = (Array.isArray(body?.paths) ? body.paths : [])
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .slice(0, 500);
    const results = await Promise.all(requested.map(async (target) => {
      const resolved = resolveFsPath(target, effectiveDir);
      try {
        const info = await stat(resolved);
        return {
          path: target,
          isDirectory: info.isDirectory(),
          ...(info.isDirectory() ? {} : { reason: "not-directory" }),
          realPath: await realpath(resolved),
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return {
          path: target,
          isDirectory: false,
          reason: code === "ENOENT" ? "not-found" : code === "ENOTDIR" ? "not-directory" : "unavailable",
        };
      }
    }));
    return json({ results });
  }

  // Filesystem write
  if ((path === "/fs/write" || path === "/api/fs/write") && req.method === "POST") {
    const body = (await readJson(req)) as { path?: string; content?: string } | undefined;
    const target = body?.path?.trim();
    if (!target) return jsonError("Path is required", 400);
    const resolved = resolveFsPath(target, effectiveDir);
    try {
      await Bun.write(resolved, body?.content ?? "");
      return json({ success: true, path: resolved });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "write failed", 500);
    }
  }

  // Filesystem delete
  if ((path === "/fs/delete" || path === "/api/fs/delete") && req.method === "POST") {
    const body = (await readJson(req)) as { path?: string } | undefined;
    const target = body?.path?.trim();
    if (!target) return jsonError("Path is required", 400);
    const resolved = resolveFsPath(target, effectiveDir);
    try {
      // OpenChamber deletes whole session folders, and retries the same
      // path, so an already-absent target counts as deleted.
      await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
      return json({ success: true });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "delete failed", 500);
    }
  }

  // Filesystem rename
  if ((path === "/fs/rename" || path === "/api/fs/rename") && req.method === "POST") {
    const body = (await readJson(req)) as { oldPath?: string; newPath?: string } | undefined;
    const oldTarget = body?.oldPath?.trim();
    const newTarget = body?.newPath?.trim();
    if (!oldTarget || !newTarget) return jsonError("oldPath and newPath are required", 400);
    const resolvedOld = resolveFsPath(oldTarget, effectiveDir);
    const resolvedNew = resolveFsPath(newTarget, effectiveDir);
    try {
      await rename(resolvedOld, resolvedNew);
      return json({ success: true });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "rename failed", 500);
    }
  }

  // Home directory endpoint
  if (path === "/api/fs/home" || path === "/fs/home") {
    const home = Bun.env.HOME || process.env.HOME || "/tmp";
    return json({ home });
  }

  // File content / file listing / find file
  if (p === "/file/content" && req.method === "GET") {
    const filePath = url.searchParams.get("path");
    if (!filePath) return jsonError("path parameter required", 400);
    try {
      const fullPath = isAbsolute(filePath) ? filePath : join(effectiveDir, filePath);
      const file = Bun.file(fullPath);
      if (!(await file.exists())) return jsonError("file not found", 404);
      const content = await file.text();
      return json({ content, path: filePath });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "file read failed", 500);
    }
  }

  if (p === "/file" && req.method === "GET") {
    const relPath = url.searchParams.get("path") ?? "";
    try {
      const targetDir = isAbsolute(relPath) ? relPath : join(effectiveDir, relPath);
      const entries = await readdir(targetDir, { withFileTypes: true });
      const list = entries.map((e) => ({
        type: e.isDirectory() ? "directory" : "file",
        path: join(relPath, e.name).replace(/\\/g, "/"),
      }));
      return json({ location: { directory: effectiveDir }, data: list });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "readdir failed", 500);
    }
  }

  if (p === "/find/file" && req.method === "GET") {
    const query = url.searchParams.get("query") ?? "";
    const requestedType = url.searchParams.get("type");
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 50;
    try {
      const entries = await readdir(effectiveDir, { recursive: true, withFileTypes: true });
      const matches = entries
        .map((entry) => {
          const raw = entry as typeof entry & { parentPath?: string; path?: string };
          const parent = raw.parentPath ?? raw.path ?? effectiveDir;
          const absolutePath = join(parent, entry.name);
          const path = absolutePath.startsWith(`${effectiveDir}/`)
            ? absolutePath.slice(effectiveDir.length + 1)
            : entry.name;
          return { path: path.replace(/\\/g, "/"), type: entry.isDirectory() ? "directory" as const : "file" as const };
        })
        .filter((entry) => (!requestedType || entry.type === requestedType) &&
          (!query || entry.path.toLowerCase().includes(query.toLowerCase())))
        .slice(0, limit);
      return json({ location: { directory: effectiveDir }, data: matches });
    } catch {
      return json({ location: { directory: effectiveDir }, data: [] });
    }
  }

  return undefined;
}
