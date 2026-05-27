export interface VideoUploadResult {
  ok: boolean;
  status: number;
  payload: { error?: string; pendingInputPath?: string; key?: string };
}

/** XHR upload so large files report progress and survive longer than default fetch idle limits. */
export function uploadVideoFile(
  url: string,
  file: File,
  options?: {
    onProgress?: (percent: number) => void;
    timeoutMs?: number;
  },
): Promise<VideoUploadResult> {
  const timeoutMs = options?.timeoutMs ?? 30 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = timeoutMs;

    xhr.upload.onprogress = (event) => {
      if (!options?.onProgress || !event.lengthComputable || event.total <= 0) {
        return;
      }
      options.onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.onload = () => {
      let payload: VideoUploadResult["payload"] = {};
      try {
        payload = JSON.parse(xhr.responseText) as VideoUploadResult["payload"];
      } catch {
        reject(new Error("Upload finished but the server returned an invalid response."));
        return;
      }
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        payload,
      });
    };

    xhr.onerror = () => {
      reject(new Error("Network error during upload. The dev server may have restarted — refresh and check if the video is already ready."));
    };
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.ontimeout = () => reject(new Error("Upload timed out. Try a smaller file or a faster connection."));

    const formData = new FormData();
    formData.set("video", file);
    xhr.send(formData);
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
