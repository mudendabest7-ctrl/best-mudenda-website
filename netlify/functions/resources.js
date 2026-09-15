import { getStore } from "@netlify/blobs";
import { randomUUID } from "crypto";

const store = getStore("best-mudenda-resources");

// Configuration
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_FILE_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/jpg"
];

const MAX_FIELD_LENGTH = 200;
const RESULT_LIMIT = 100;

// Helper functions
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });

const sanitize = (str) => {
  if (typeof str !== "string") return "";
  return str.trim().slice(0, MAX_FIELD_LENGTH).replace(/[<>"']/g, "");
};

const validateAdminKey = (request) => {
  const key = request.headers.get("x-admin-key");
  if (!key || key !== process.env.ADMIN_KEY) {
    return false;
  }
  return true;
};

const log = (message, data = {}) => {
  console.log(`[${new Date().toISOString()}] ${message}`, JSON.stringify(data));
};

const errorLog = (message, error) => {
  console.error(`[${new Date().toISOString()}] ${message}`, error.message || error);
};

// GET: List all resources
const handleGet = async (request) => {
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), RESULT_LIMIT);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0"), 0);

    const { blobs } = await store.list();
    const resources = [];

    for (const blob of blobs) {
      if (!blob.key.startsWith("metadata/")) continue;
      
      try {
        const data = await store.get(blob.key, { type: "json" });
        if (data?.metadata) {
          resources.push(data.metadata);
        }
      } catch (error) {
        errorLog(`Failed to parse metadata for ${blob.key}`, error);
        // Continue with next blob
      }
    }

    // Sort by most recent first
    resources.sort((a, b) =>
      new Date(b.uploadedAt) - new Date(a.uploadedAt)
    );

    // Apply pagination
    const paginatedResources = resources.slice(offset, offset + limit);

    return response({
      resources: paginatedResources,
      total: resources.length,
      offset,
      limit,
      hasMore: offset + limit < resources.length
    });
  } catch (error) {
    errorLog("GET handler error", error);
    return response({ error: "Failed to fetch resources" }, 500);
  }
};

// POST: Upload new resource
const handlePost = async (request) => {
  try {
    // Validate admin key
    if (!validateAdminKey(request)) {
      return response({ error: "Unauthorized" }, 401);
    }

    const form = await request.formData();
    const file = form.get("file");
    const title = form.get("title");
    const subject = form.get("subject");
    const grade = form.get("grade");
    const description = form.get("description") || "";

    // Validate file
    if (!file || typeof file === "string") {
      return response({ error: "Select a file." }, 400);
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return response(
        {
          error: `File size exceeds limit of ${MAX_FILE_SIZE / 1024 / 1024}MB`
        },
        413
      );
    }

    // Validate file type
    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      return response(
        {
          error: `File type '${file.type}' not allowed. Supported types: PDF, Word, Excel, Text, PNG, JPEG`
        },
        415
      );
    }

    // Validate required fields
    if (!title || !subject || !grade) {
      return response(
        { error: "Title, subject, and grade are required." },
        400
      );
    }

    // Sanitize inputs
    const sanitizedTitle = sanitize(title);
    const sanitizedSubject = sanitize(subject);
    const sanitizedGrade = sanitize(grade);
    const sanitizedDescription = sanitize(description);

    if (!sanitizedTitle || !sanitizedSubject || !sanitizedGrade) {
      return response(
        { error: "Title, subject, and grade cannot be empty after validation." },
        400
      );
    }

    // Generate unique ID
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const fileKey = `files/${id}-${file.name}`;

    // Create resource object
    const resource = {
      id,
      title: sanitizedTitle,
      subject: sanitizedSubject,
      grade: sanitizedGrade,
      description: sanitizedDescription,
      fileName: file.name,
      fileKey,
      fileType: file.type,
      size: file.size,
      uploadedAt: new Date().toISOString()
    };

    // Store metadata first (with rollback capability)
    try {
      await store.setJSON(`metadata/${id}`, { metadata: resource });
    } catch (error) {
      errorLog("Failed to store metadata", error);
      return response({ error: "Failed to store resource metadata" }, 500);
    }

    // Then store file
    try {
      await store.set(fileKey, await file.arrayBuffer(), {
        metadata: { contentType: file.type }
      });
    } catch (error) {
      errorLog("Failed to store file, cleaning up metadata", error);
      // Attempt rollback
      try {
        await store.delete(`metadata/${id}`);
      } catch (rollbackError) {
        errorLog("Rollback failed for metadata", rollbackError);
      }
      return response({ error: "Failed to store file" }, 500);
    }

    log("Resource uploaded successfully", { id, fileName: file.name, size: file.size });
    return response({ success: true, resource }, 201);
  } catch (error) {
    errorLog("POST handler error", error);
    return response({ error: "Server error" }, 500);
  }
};

// DELETE: Remove resource
const handleDelete = async (request) => {
  try {
    // Validate admin key
    if (!validateAdminKey(request)) {
      return response({ error: "Unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return response({ error: "Resource ID is required" }, 400);
    }

    // Fetch metadata to get file key
    let metadata;
    try {
      metadata = await store.get(`metadata/${id}`, { type: "json" });
      if (!metadata?.metadata) {
        return response({ error: "Resource not found" }, 404);
      }
    } catch (error) {
      return response({ error: "Resource not found" }, 404);
    }

    const fileKey = metadata.metadata.fileKey;

    // Delete both metadata and file in parallel
    const deleteResults = await Promise.allSettled([
      store.delete(`metadata/${id}`),
      store.delete(fileKey)
    ]);

    const metadataDeleted = deleteResults[0].status === "fulfilled";
    const fileDeleted = deleteResults[1].status === "fulfilled";

    if (!metadataDeleted) {
      errorLog("Failed to delete metadata", deleteResults[0].reason);
      return response({ error: "Failed to delete resource" }, 500);
    }

    if (!fileDeleted) {
      errorLog("Failed to delete file", deleteResults[1].reason);
      // Metadata deleted but file wasn't - still return success but log warning
      log("Orphaned file warning", { id, fileKey });
    }

    log("Resource deleted successfully", { id });
    return response({ success: true, message: "Resource deleted" });
  } catch (error) {
    errorLog("DELETE handler error", error);
    return response({ error: "Server error" }, 500);
  }
};

// Main handler
export default async (request) => {
  try {
    if (request.method === "GET") {
      return await handleGet(request);
    }

    if (request.method === "POST") {
      return await handlePost(request);
    }

    if (request.method === "DELETE") {
      return await handleDelete(request);
    }

    return response({ error: "Method not allowed" }, 405);
  } catch (error) {
    errorLog("Unhandled error in main handler", error);
    return response({ error: "Internal server error" }, 500);
  }
};
