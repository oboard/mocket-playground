<script setup lang="ts">
import { computed, ref } from "vue";

type RequestLog = {
  method: string;
  path: string;
  status: number;
  time: string;
  duration: string;
  size: string;
};

type Header = { enabled: boolean; key: string; value: string };

const props = defineProps<{ baseUrl: string; isRuntimeReady: boolean }>();

const method = ref("GET");
const path = ref("/api/hello");
const activeSection = ref<"params" | "authorization" | "headers" | "body">("params");
const bodyType = ref("raw");
const body = ref('{\n  "name": "MoonBit"\n}');
const headers = ref<Header[]>([
  { enabled: true, key: "Content-Type", value: "application/json" },
  { enabled: false, key: "", value: "" },
]);
const responseText = ref("Click Send to call your running Mocket service.");
const responseStatus = ref<number | null>(null);
const responseTime = ref("—");
const responseSize = ref("—");
const responseHeaders = ref<string[]>([]);
const responseTab = ref<"body" | "headers">("body");
const sending = ref(false);
const saved = ref(false);
const logs = ref<RequestLog[]>([]);

const canHaveBody = computed(() => !["GET", "HEAD"].includes(method.value));
const formattedBaseUrl = computed(() => props.baseUrl || "http://localhost:4000");
const responseLabel = computed(() => {
  if (sending.value) return "Sending…";
  if (responseStatus.value === null) return "No response";
  return `${responseStatus.value} ${responseStatus.value < 400 ? "OK" : "Error"}`;
});

function now() {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

function readableSize(value: string) {
  const bytes = new TextEncoder().encode(value).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function activeHeaders() {
  return headers.value.reduce<Record<string, string>>((result, header) => {
    if (header.enabled && header.key.trim()) result[header.key.trim()] = header.value;
    return result;
  }, {});
}

function addHeader() {
  headers.value.push({ enabled: true, key: "", value: "" });
}

function removeHeader(index: number) {
  if (headers.value.length === 1) {
    headers.value[0] = { enabled: false, key: "", value: "" };
    return;
  }
  headers.value.splice(index, 1);
}

function loadLog(log: RequestLog) {
  method.value = log.method;
  path.value = log.path;
  responseStatus.value = log.status;
  responseTime.value = log.duration;
}

function saveRequest() {
  saved.value = true;
  window.setTimeout(() => {
    saved.value = false;
  }, 1600);
}

async function sendRequest() {
  sending.value = true;
  responseStatus.value = null;
  responseHeaders.value = [];
  const started = performance.now();

  if (!props.baseUrl) {
    responseText.value =
      "Start the workspace first. The request will use the preview URL as its base address.";
    responseStatus.value = 503;
    responseTime.value = `${Math.round(performance.now() - started)} ms`;
    responseSize.value = readableSize(responseText.value);
    logs.value.unshift({
      method: method.value,
      path: path.value,
      status: 503,
      time: now(),
      duration: responseTime.value,
      size: responseSize.value,
    });
    sending.value = false;
    return;
  }

  try {
    const response = await fetch(new URL(path.value, props.baseUrl), {
      method: method.value,
      headers: activeHeaders(),
      body: canHaveBody.value && body.value ? body.value : undefined,
    });
    const result = await response.text();
    try {
      responseText.value = JSON.stringify(JSON.parse(result), null, 2);
    } catch {
      responseText.value = result || "(empty response)";
    }
    responseStatus.value = response.status;
    responseTime.value = `${Math.round(performance.now() - started)} ms`;
    responseSize.value = readableSize(result);
    responseHeaders.value = Array.from(response.headers.entries()).map(
      ([key, value]) => `${key}: ${value}`,
    );
    logs.value.unshift({
      method: method.value,
      path: path.value,
      status: response.status,
      time: now(),
      duration: responseTime.value,
      size: responseSize.value,
    });
  } catch (error) {
    responseText.value = error instanceof Error ? error.message : String(error);
    responseStatus.value = 500;
    responseTime.value = `${Math.round(performance.now() - started)} ms`;
    responseSize.value = readableSize(responseText.value);
    logs.value.unshift({
      method: method.value,
      path: path.value,
      status: 500,
      time: now(),
      duration: responseTime.value,
      size: responseSize.value,
    });
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <section class="api-client" aria-label="API client">
    <header class="client-header">
      <div class="client-title">
        <span class="client-dot"></span><span>Untitled request</span
        ><small>{{ isRuntimeReady ? "Connected" : "Local workspace" }}</small>
      </div>
      <div class="client-actions">
        <button class="text-action" @click="saveRequest">{{ saved ? "Saved" : "Save" }}</button
        ><button class="more-action" aria-label="More request actions">•••</button>
      </div>
    </header>

    <div class="environment-bar">
      <span>Environment</span
      ><button>{{ baseUrl ? "Mocket preview" : "No environment" }} <b>⌄</b></button>
    </div>

    <div class="request-editor">
      <div class="url-row">
        <select
          v-model="method"
          :class="`method-${method.toLowerCase()}`"
          aria-label="Request method"
        >
          <option>GET</option>
          <option>POST</option>
          <option>PUT</option>
          <option>PATCH</option>
          <option>DELETE</option>
        </select>
        <input
          v-model="path"
          aria-label="Request URL"
          :placeholder="`${formattedBaseUrl}/api/hello`"
          @keydown.enter="sendRequest"
        />
        <button class="send-button" :disabled="sending" @click="sendRequest">
          {{ sending ? "Sending" : "Send" }} <span>⌄</span>
        </button>
      </div>
      <p class="base-url"><span>Base URL</span>{{ formattedBaseUrl }}</p>

      <div class="request-tabs" role="tablist">
        <button :class="{ active: activeSection === 'params' }" @click="activeSection = 'params'">
          Params
        </button>
        <button
          :class="{ active: activeSection === 'authorization' }"
          @click="activeSection = 'authorization'"
        >
          Authorization
        </button>
        <button :class="{ active: activeSection === 'headers' }" @click="activeSection = 'headers'">
          Headers <span>{{ headers.filter((header) => header.enabled && header.key).length }}</span>
        </button>
        <button :class="{ active: activeSection === 'body' }" @click="activeSection = 'body'">
          Body
        </button>
      </div>

      <div class="request-content">
        <div v-if="activeSection === 'params'" class="empty-section">
          <strong>Query parameters</strong>
          <p>Add parameters directly to the URL or switch to another request setting.</p>
        </div>
        <div v-else-if="activeSection === 'authorization'" class="empty-section">
          <strong>No authentication</strong>
          <p>Requests are sent from this browser to your preview server.</p>
        </div>
        <div v-else-if="activeSection === 'headers'" class="headers-editor">
          <div class="header-row header-labels">
            <span></span><span>KEY</span><span>VALUE</span><span></span>
          </div>
          <div v-for="(header, index) in headers" :key="index" class="header-row">
            <input
              v-model="header.enabled"
              type="checkbox"
              :aria-label="`Enable header ${index + 1}`"
            />
            <input v-model="header.key" placeholder="Header" aria-label="Header name" />
            <input v-model="header.value" placeholder="Value" aria-label="Header value" />
            <button aria-label="Remove header" @click="removeHeader(index)">×</button>
          </div>
          <button class="add-row" @click="addHeader">+ Add header</button>
        </div>
        <div v-else class="body-editor" :class="{ disabled: !canHaveBody }">
          <div class="body-options">
            <label
              ><input v-model="bodyType" type="radio" value="raw" :disabled="!canHaveBody" />
              raw</label
            ><label><input type="radio" disabled /> form-data</label><span>JSON</span>
          </div>
          <textarea
            v-model="body"
            :disabled="!canHaveBody"
            spellcheck="false"
            aria-label="Request body"
          ></textarea>
        </div>
      </div>
    </div>

    <div class="response-panel">
      <div class="response-header">
        <div>
          <strong>Response</strong
          ><span :class="{ error: responseStatus && responseStatus >= 400 }">{{
            responseLabel
          }}</span>
        </div>
        <div class="response-meta">
          <span>{{ responseTime }}</span
          ><span>{{ responseSize }}</span>
        </div>
      </div>
      <div class="response-tabs">
        <button :class="{ active: responseTab === 'body' }" @click="responseTab = 'body'">
          Body</button
        ><button :class="{ active: responseTab === 'headers' }" @click="responseTab = 'headers'">
          Headers <span>{{ responseHeaders.length }}</span>
        </button>
      </div>
      <pre v-if="responseTab === 'body'" class="response-code">{{ responseText }}</pre>
      <pre v-else class="response-code response-headers">{{
        responseHeaders.length
          ? responseHeaders.join("\n")
          : "Headers appear after a response is received."
      }}</pre>
    </div>

    <footer class="history-panel">
      <div class="history-title"><span>History</span><button @click="logs = []">Clear</button></div>
      <button
        v-for="log in logs.slice(0, 4)"
        :key="`${log.time}-${log.path}`"
        class="history-row"
        @click="loadLog(log)"
      >
        <b :class="`method-${log.method.toLowerCase()}`">{{ log.method }}</b
        ><span>{{ log.path }}</span
        ><em :class="{ failed: log.status >= 400 }">{{ log.status }}</em
        ><small>{{ log.time }}</small>
      </button>
      <p v-if="!logs.length" class="history-empty">Sent requests will appear here.</p>
    </footer>
  </section>
</template>

<style scoped>
.api-client {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  background: #1e1e1e;
  color: #dedede;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}
.client-header {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid #343434;
}
.client-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 650;
}
.client-title small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #888;
  font-size: 10px;
  font-weight: 500;
}
.client-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff6c37;
  box-shadow: 0 0 0 3px #3a2c27;
}
.client-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.text-action,
.more-action {
  border: 0;
  background: transparent;
  color: #aaa;
  font: 600 11px/1 inherit;
}
.text-action:hover {
  color: #fff;
}
.more-action {
  font-size: 15px;
  letter-spacing: 1px;
}
.environment-bar {
  display: flex;
  height: 31px;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid #343434;
  background: #252525;
  color: #8f8f8f;
  font:
    10px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}
.environment-bar button {
  border: 0;
  background: transparent;
  color: #d0d0d0;
  font: 10px inherit;
}
.environment-bar b {
  margin-left: 4px;
  color: #777;
}
.request-editor {
  padding: 13px 14px 0;
  border-bottom: 1px solid #363636;
}
.url-row {
  display: grid;
  grid-template-columns: 75px minmax(0, 1fr) 76px;
  height: 39px;
}
.url-row select,
.url-row input {
  min-width: 0;
  border: 1px solid #464646;
  background: #272727;
  color: #efefef;
  outline: 0;
  font:
    11px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}
.url-row select {
  padding: 0 8px;
  border-radius: 4px 0 0 4px;
  font-weight: 700;
}
.url-row input {
  border-left: 0;
  padding: 0 10px;
}
.url-row input:focus,
.header-row input:focus,
.body-editor textarea:focus {
  border-color: #ff6c37;
}
.method-get {
  color: #65d58e !important;
}
.method-post {
  color: #f3ad59 !important;
}
.method-put {
  color: #70b8ff !important;
}
.method-patch {
  color: #c993f9 !important;
}
.method-delete {
  color: #fa7373 !important;
}
.send-button {
  border: 0;
  border-radius: 0 4px 4px 0;
  background: #ff6c37;
  color: #171717;
  font-weight: 750;
  font-size: 11px;
}
.send-button:disabled {
  opacity: 0.65;
}
.send-button span {
  margin-left: 5px;
  font-size: 9px;
}
.base-url {
  display: flex;
  gap: 8px;
  overflow: hidden;
  margin: 8px 1px 10px;
  color: #858585;
  font:
    10px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.base-url span {
  color: #6f6f6f;
}
.request-tabs,
.response-tabs {
  display: flex;
  gap: 18px;
}
.request-tabs button,
.response-tabs button {
  position: relative;
  padding: 0 0 10px;
  border: 0;
  background: transparent;
  color: #919191;
  font: 11px inherit;
}
.request-tabs button.active,
.response-tabs button.active {
  color: #fff;
}
.request-tabs button.active::after,
.response-tabs button.active::after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  background: #ff6c37;
  content: "";
}
.request-tabs span,
.response-tabs span {
  display: inline-grid;
  min-width: 15px;
  place-items: center;
  border-radius: 8px;
  background: #393939;
  color: #a8a8a8;
  font-size: 9px;
}
.request-content {
  min-height: 112px;
  padding: 12px 0;
}
.empty-section {
  padding: 8px 0;
  color: #aaa;
  font-size: 11px;
}
.empty-section strong {
  color: #ddd;
  font-size: 11px;
}
.empty-section p {
  margin: 6px 0 0;
  color: #777;
  font-size: 10px;
  line-height: 1.5;
}
.headers-editor {
  font:
    10px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}
.header-row {
  display: grid;
  grid-template-columns: 24px minmax(60px, 1fr) minmax(60px, 1.2fr) 22px;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
}
.header-row input:not([type="checkbox"]) {
  min-width: 0;
  height: 28px;
  border: 1px solid #414141;
  border-radius: 3px;
  background: #292929;
  padding: 0 7px;
  color: #dedede;
  font: 10px inherit;
  outline: 0;
}
.header-row input[type="checkbox"] {
  accent-color: #ff6c37;
}
.header-row button {
  border: 0;
  background: transparent;
  color: #777;
  font-size: 17px;
}
.header-labels {
  padding: 0 5px;
  color: #777;
  font-size: 9px;
}
.add-row {
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: #ff936d;
  font: 10px inherit;
}
.body-options {
  display: flex;
  align-items: center;
  gap: 13px;
  margin-bottom: 8px;
  color: #a3a3a3;
  font-size: 10px;
}
.body-options label {
  display: flex;
  align-items: center;
  gap: 4px;
}
.body-options input {
  accent-color: #ff6c37;
}
.body-options span {
  margin-left: auto;
  color: #777;
}
.body-editor textarea {
  box-sizing: border-box;
  width: 100%;
  height: 92px;
  resize: vertical;
  border: 1px solid #414141;
  border-radius: 4px;
  background: #171717;
  padding: 9px;
  color: #d5d5d5;
  font:
    10px/1.6 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  outline: 0;
}
.body-editor.disabled {
  opacity: 0.45;
}
.response-panel {
  min-height: 0;
  flex: 1;
  padding: 13px 14px;
  border-bottom: 1px solid #363636;
}
.response-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 13px;
}
.response-header > div:first-child {
  display: flex;
  align-items: baseline;
  gap: 9px;
}
.response-header strong {
  font-size: 12px;
}
.response-header strong + span {
  color: #60cd89;
  font:
    10px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}
.response-header .error {
  color: #fa7373;
}
.response-meta {
  display: flex;
  gap: 8px;
  color: #858585;
  font:
    10px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}
.response-code {
  box-sizing: border-box;
  max-height: 200px;
  min-height: 105px;
  overflow: auto;
  margin: 0;
  border-top: 1px solid #373737;
  background: #191919;
  padding: 11px;
  color: #d3d3d3;
  font:
    10px/1.65 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  white-space: pre-wrap;
}
.response-headers {
  color: #adbdca;
}
.history-panel {
  max-height: 145px;
  padding: 11px 14px;
  overflow: auto;
  background: #1b1b1b;
}
.history-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  color: #aaa;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.history-title button {
  border: 0;
  background: transparent;
  color: #777;
  font-size: 10px;
}
.history-row {
  display: grid;
  width: 100%;
  grid-template-columns: 46px minmax(0, 1fr) 27px 54px;
  gap: 5px;
  align-items: center;
  padding: 5px 0;
  border: 0;
  border-bottom: 1px solid #292929;
  background: transparent;
  text-align: left;
  color: #a9a9a9;
  font:
    10px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}
.history-row b {
  font-size: 9px;
}
.history-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-row em {
  color: #60cd89;
  font-style: normal;
}
.history-row em.failed {
  color: #fa7373;
}
.history-row small {
  color: #6f6f6f;
  font-size: 9px;
}
.history-empty {
  margin: 16px 0 6px;
  color: #727272;
  font-size: 10px;
  text-align: center;
}
</style>
