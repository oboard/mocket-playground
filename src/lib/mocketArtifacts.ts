export type MocketJavaScriptArtifacts = {
  miFiles: [string, Uint8Array][];
  coreFiles: Uint8Array[];
  pkgSources: string[];
};

type SerializedArtifacts = {
  version: number;
  target: "js";
  miFiles: [string, string][];
  coreFiles: string[];
  pkgSources: string[];
};

let artifactsPromise: Promise<MocketJavaScriptArtifacts> | undefined;

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function decodeGzipJson(response: Response) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This browser does not support DecompressionStream, which Mocket’s offline compiler needs.",
    );
  }
  const stream = response.body?.pipeThrough(new DecompressionStream("gzip"));
  if (!stream) throw new Error("The Mocket JS artifact download did not include a response body.");
  return (await new Response(stream).json()) as SerializedArtifacts;
}

async function fetchArtifacts() {
  const response = await fetch(`${import.meta.env.BASE_URL}moonbit/mocket-js-artifacts.json.gz`);
  if (!response.ok) {
    throw new Error(`Could not download the built-in Mocket JS artifacts (${response.status}).`);
  }
  // Vite and normal static hosts serve the `.gz` file with `Content-Encoding:
  // gzip`. Fetch transparently decodes an HTTP content-encoded response, so
  // piping it through DecompressionStream again would leave the first Run
  // waiting on an invalid gzip stream. A raw `.gz` response is also supported
  // for simple file hosts that do not add that header.
  const payload = response.headers.get("content-encoding")
    ? ((await response.json()) as SerializedArtifacts)
    : await decodeGzipJson(response);
  if (payload.version !== 1 || payload.target !== "js") {
    throw new Error("The Mocket JS artifact bundle has an unsupported format.");
  }
  return {
    miFiles: payload.miFiles.map(
      ([path, content]) => [path, decodeBase64(content)] as [string, Uint8Array],
    ),
    coreFiles: payload.coreFiles.map(decodeBase64),
    pkgSources: payload.pkgSources,
  };
}

/** Loads the prebuilt Mocket + async JS interfaces and cores on first use. */
export function getMocketJavaScriptArtifacts() {
  artifactsPromise ??= fetchArtifacts();
  return artifactsPromise;
}
