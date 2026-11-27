import {
  App, ItemView, Keymap, MarkdownRenderer, MarkdownView, Modal, Notice, Plugin, PluginSettingTab,
  Setting, TAbstractFile, TFile, WorkspaceLeaf, moment, requestUrl, setIcon,
} from "obsidian";

const VIEW_TYPE = "vault-rag-view";

interface Settings {
  ollamaUrl: string;
  weaviateUrl: string;
  chatModel: string;
  embedModel: string;
  collection: string;
  topK: number;
  maxChars: number;
  skipFolders: string;
  alpha: number;
  liveIndex: boolean;
}

const DEFAULTS: Settings = {
  ollamaUrl: "http://127.0.0.1:11434",
  weaviateUrl: "http://127.0.0.1:8080",
  chatModel: "qwen3:8b",
  embedModel: "nomic-embed-text",
  collection: "Vault",
  topK: 6,
  maxChars: 1500,
  skipFolders: "templates",
  alpha: 0.5,
  liveIndex: true,
};

const PINNED_MAX_CHARS = 4000;
const PINNED_MAX_NOTES = 3;

interface Hit {
  text: string;
  source: string;
  heading: string;
  pinned?: boolean;
  _additional?: { score?: string };
}

interface Row { source: string; heading: string; text: string }

async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  // requestUrl goes through Electron, so no CORS issues with Weaviate or Ollama
  const res = await requestUrl({
    url, method, contentType: "application/json",
    body: body === undefined ? undefined : JSON.stringify(body), throw: false,
  });
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${res.text.slice(0, 300)}`);
  return res.text ? (res.json as T) : (undefined as T);
}

const sourceOf = (path: string) => path.replace(/\.md$/, "");

export default class VaultRagPlugin extends Plugin {
  settings: Settings = DEFAULTS;
  private pending = new Map<string, number>();  // path → debounce timer
  private reindexing = false;

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new AskView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE, { display: "Vault RAG", defaultMod: true });
    this.addRibbonIcon("message-circle-question", "Ask vault", () => this.openView());
    this.addCommand({ id: "ask", name: "Ask vault", callback: () => this.openView() });
    this.addCommand({ id: "reindex", name: "Reindex vault", callback: () => this.reindex() });
    this.addCommand({
      id: "index-current", name: "Index current note",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md") return false;
        if (!checking) this.indexFile(f).then(() => new Notice(`Vault RAG: indexed ${f.basename}`),
          (e) => new Notice(`Vault RAG: ${(e as Error).message}`));
        return true;
      },
    });
    this.addSettingTab(new RagSettingTab(this.app, this));

    // Live index. Registered after layout-ready, so the startup "create" events for every file are skipped.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (f) => this.schedule(f)));
      this.registerEvent(this.app.vault.on("modify", (f) => this.schedule(f)));
      this.registerEvent(this.app.vault.on("delete", (f) => this.onDelete(f)));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
        this.onDelete({ path: oldPath } as TAbstractFile);
        this.schedule(f);
      }));
    });
  }

  onunload() { this.pending.forEach((t) => window.clearTimeout(t)); }

  async saveSettings() { await this.saveData(this.settings); }

  async openView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    (leaf.view as AskView).focusInput();
  }

  skipped(path: string): boolean {
    const skip = this.settings.skipFolders.split(",").map((s) => s.trim()).filter(Boolean);
    return skip.some((d) => path === d || path.startsWith(d + "/"));
  }

  // ---------- retrieval ----------

  async embed(texts: string[], kind: "doc" | "query"): Promise<number[][]> {
    const prefix = kind === "doc" ? "search_document: " : "search_query: ";
    const out = await postJson<{ embeddings: number[][] }>(`${this.settings.ollamaUrl}/api/embed`, {
      model: this.settings.embedModel, input: texts.map((t) => prefix + t),
    });
    return out.embeddings;
  }

  /** Hybrid search: BM25 on text, source and heading, plus vector similarity. */
  async search(question: string): Promise<Hit[]> {
    const [vec] = await this.embed([question], "query");
    const { collection, topK, alpha } = this.settings;
    const query = `{ Get { ${collection}(hybrid: {query: ${JSON.stringify(question)}, vector: ${JSON.stringify(vec)}, alpha: ${alpha}}, limit: ${topK}) {
      text source heading _additional { score } } } }`;
    const res = await postJson<any>(`${this.settings.weaviateUrl}/v1/graphql`, { query });
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    return res.data.Get[collection] ?? [];
  }

  /** Notes the question names directly: today / tomorrow / a date, or an exact note title. */
  async pinnedNotes(question: string): Promise<Hit[]> {
    const q = question.toLowerCase();
    const dates = new Set<string>();
    const rel: [RegExp, number][] = [
      [/\b(today|tonight)\b|aujourd'?hui|ce soir/, 0],
      [/\btomorrow\b|\bdemain\b/, 1],
      [/\byesterday\b|\bhier\b/, -1],
    ];
    for (const [re, d] of rel) if (re.test(q)) dates.add(moment().add(d, "day").format("YYYY-MM-DD"));
    for (const m of q.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) dates.add(m[1]);

    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.skipped(f.path));
    const matches = files.filter((f) => {
      const name = f.basename.toLowerCase();
      return dates.has(name) || (name.length >= 6 && q.includes(name));
    }).sort((a, b) => Number(dates.has(b.basename)) - Number(dates.has(a.basename))
      || b.basename.length - a.basename.length)
      .slice(0, PINNED_MAX_NOTES);

    const out: Hit[] = [];
    for (const f of matches) {
      const text = (await this.app.vault.cachedRead(f)).slice(0, PINNED_MAX_CHARS);
      out.push({ text: text || "(empty note)", source: sourceOf(f.path), heading: "whole note", pinned: true });
    }
    return out;
  }

  async retrieve(question: string): Promise<Hit[]> {
    const [pinned, hits] = await Promise.all([this.pinnedNotes(question), this.search(question)]);
    const pinnedSources = new Set(pinned.map((p) => p.source));
    return [...pinned, ...hits.filter((h) => !pinnedSources.has(h.source))];
  }

  buildPrompt(question: string, hits: Hit[]): string {
    const context = hits.map((h, i) => `[${i + 1}] (${h.source} / ${h.heading})\n${h.text}`).join("\n\n");
    return `Today is ${moment().format("dddd YYYY-MM-DD")}. ` +
      "You answer questions about the user's personal notes. Use only the context. " +
      "Daily notes are named YYYY-MM-DD; their checklist items are that day's plan. " +
      "Cite sources as [1], [2]. If the context does not contain the answer, say so. " +
      "Answer in the language of the question.\n\n" +
      `Context:\n${context}\n\nQuestion: ${question}`;
  }

  /** Can we reach both services? Cheap calls, used for the status light. */
  async health(): Promise<{ ollama: boolean; weaviate: boolean }> {
    const ok = async (url: string) => {
      try { return (await requestUrl({ url, throw: false })).status < 400; } catch { return false; }
    };
    const [ollama, weaviate] = await Promise.all([
      ok(`${this.settings.ollamaUrl}/api/tags`),
      ok(`${this.settings.weaviateUrl}/v1/.well-known/ready`),
    ]);
    return { ollama, weaviate };
  }

  /**
   * Streams the answer through onToken. Falls back to one blocking call if streaming fails.
   * history: earlier question/answer pairs, so follow-ups like "and tomorrow?" make sense.
   */
  async chat(prompt: string, history: { question: string; answer: string }[],
    onToken: (t: string) => void, signal: AbortSignal): Promise<{ tokS?: number }> {
    const messages = history.flatMap((t) => [
      { role: "user", content: t.question }, { role: "assistant", content: t.answer },
    ]);
    const body = {
      model: this.settings.chatModel, think: false,
      messages: [...messages, { role: "user", content: prompt }],
    };
    let res: Response;
    try {
      res = await fetch(`${this.settings.ollamaUrl}/api/chat`, {
        method: "POST", body: JSON.stringify({ ...body, stream: true }), signal,
      });
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
    } catch (e) {
      if (signal.aborted) throw e;
      const out = await postJson<any>(`${this.settings.ollamaUrl}/api/chat`, { ...body, stream: false });
      onToken(out.message.content);
      return { tokS: out.eval_count / (out.eval_duration / 1e9) };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let tokS: number | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.message?.content) onToken(msg.message.content);
        if (msg.done && msg.eval_count) tokS = msg.eval_count / (msg.eval_duration / 1e9);
      }
    }
    return { tokS };
  }

  // ---------- indexing ----------

  *chunks(text: string): Generator<[string, string]> {
    let heading = "";
    for (let part of text.split(/\n(?=#{1,3} |> \[!)/)) {
      part = part.trim();
      if (!part || part.startsWith("Back to [[")) continue;
      if (part.startsWith("#")) heading = part.split("\n")[0].replace(/^#+\s*/, "").trim();
      for (let i = 0; i < part.length; i += this.settings.maxChars) {
        const c = part.slice(i, i + this.settings.maxChars);
        if (c.trim()) yield [heading, c];
      }
    }
  }

  async rowsFor(f: TFile): Promise<Row[]> {
    const text = await this.app.vault.cachedRead(f);
    const source = sourceOf(f.path);
    const rows = [...this.chunks(text)].map(([heading, t]) => ({ source, heading, text: t }));
    // An empty note still gets one row, so it can be found by name
    return rows.length ? rows : [{ source, heading: "", text: "(empty note)" }];
  }

  /** The note path goes into the embedding, so "2026-11-27" or a project name finds the note. */
  async upload(rows: Row[]) {
    const { weaviateUrl, collection } = this.settings;
    const vectors = await this.embed(rows.map((r) => `${r.source} › ${r.heading}\n${r.text}`), "doc");
    const res = await postJson<any[]>(`${weaviateUrl}/v1/batch/objects`, {
      objects: rows.map((r, j) => ({ class: collection, properties: r, vector: vectors[j] })),
    });
    const err = res.find((r) => r.result?.errors);
    if (err) throw new Error(JSON.stringify(err.result.errors));
  }

  async deleteSource(source: string) {
    const { weaviateUrl, collection } = this.settings;
    await postJson(`${weaviateUrl}/v1/batch/objects`, {
      match: { class: collection, where: { path: ["source"], operator: "Equal", valueText: source } },
    }, "DELETE");
  }

  async indexFile(f: TFile) {
    const rows = await this.rowsFor(f);
    await this.deleteSource(sourceOf(f.path));
    for (let i = 0; i < rows.length; i += 32) await this.upload(rows.slice(i, i + 32));
  }

  schedule(f: TAbstractFile) {
    if (!this.settings.liveIndex || !(f instanceof TFile) || f.extension !== "md" || this.skipped(f.path)) return;
    window.clearTimeout(this.pending.get(f.path));
    this.pending.set(f.path, window.setTimeout(async () => {
      this.pending.delete(f.path);
      if (this.reindexing) return;
      try { await this.indexFile(f); } catch (e) { console.warn("Vault RAG: live index failed", f.path, e); }
    }, 2000));
  }

  onDelete(f: TAbstractFile) {
    if (!this.settings.liveIndex || !f.path.endsWith(".md") || this.reindexing) return;
    window.clearTimeout(this.pending.get(f.path));
    this.deleteSource(sourceOf(f.path)).catch((e) => console.warn("Vault RAG: delete failed", f.path, e));
  }

  async reindex() {
    if (this.reindexing) return;
    this.reindexing = true;
    const { weaviateUrl, collection } = this.settings;
    const files = this.app.vault.getMarkdownFiles()
      .filter((f) => !this.skipped(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    const notice = new Notice("Vault RAG: reading notes…", 0);
    try {
      const rows: Row[] = [];
      for (const f of files) rows.push(...await this.rowsFor(f));
      await postJson(`${weaviateUrl}/v1/schema/${collection}`, undefined, "DELETE").catch(() => {});
      await postJson(`${weaviateUrl}/v1/schema`, {
        class: collection, vectorizer: "none", vectorIndexConfig: { distance: "cosine" },
        properties: ["text", "source", "heading"].map((name) => ({ name, dataType: ["text"] })),
      });
      const t0 = Date.now();
      for (let i = 0; i < rows.length; i += 32) {
        await this.upload(rows.slice(i, i + 32));
        notice.setMessage(`Vault RAG: indexed ${Math.min(i + 32, rows.length)} / ${rows.length} chunks`);
      }
      notice.hide();
      new Notice(`Vault RAG: ${rows.length} chunks from ${files.length} notes in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e) {
      notice.hide();
      new Notice(`Vault RAG reindex failed: ${(e as Error).message}`, 10000);
    } finally {
      this.reindexing = false;
    }
  }
}

interface Turn { question: string; answer: string }

const SUGGESTIONS = [
  "What's on my plan today?",
  "What did I write last week?",
  "Summarize my notes about the project I'm working on",
];

class ConfirmModal extends Modal {
  constructor(app: App, private message: string, private cta: string, private onYes: () => void) { super(app); }
  onOpen() {
    this.titleEl.setText("Vault RAG");
    this.contentEl.createEl("p", { text: this.message });
    const row = this.contentEl.createDiv("modal-button-container");
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    row.createEl("button", { text: this.cta, cls: "mod-cta" }).onclick = () => { this.close(); this.onYes(); };
  }
  onClose() { this.contentEl.empty(); }
}

class AskView extends ItemView {
  plugin: VaultRagPlugin;
  thread!: HTMLElement;
  input!: HTMLTextAreaElement;
  sendBtn!: HTMLButtonElement;
  dot!: HTMLElement;
  turns: Turn[] = [];
  abort: AbortController | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VaultRagPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Ask vault"; }
  getIcon() { return "message-circle-question"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("vault-rag");

    const header = root.createDiv("vr-header");
    const title = header.createDiv("vr-title");
    this.dot = title.createSpan("vr-dot");
    title.createSpan({ text: "Ask vault" });
    const actions = header.createDiv("vr-header-actions");
    this.iconButton(actions, "refresh-cw", "Reindex vault", () =>
      new ConfirmModal(this.app, "Rebuild the whole index? It takes about 8 minutes and search is incomplete meanwhile.",
        "Reindex", () => this.plugin.reindex()).open());
    this.iconButton(actions, "square-pen", "New conversation", () => this.clear());

    this.thread = root.createDiv("vr-thread");
    this.renderEmpty();

    const composer = root.createDiv("vr-composer");
    const box = composer.createDiv("vr-input");
    this.input = box.createEl("textarea", { attr: { rows: "1", placeholder: "Ask about your notes…" } });
    this.sendBtn = box.createEl("button", { cls: "vr-send", attr: { "aria-label": "Send" } });
    setIcon(this.sendBtn, "arrow-up");
    composer.createDiv({ cls: "vr-hint", text: "Enter to send · Shift+Enter for a new line" });

    this.sendBtn.onclick = () => this.ask();
    this.input.addEventListener("input", () => this.autosize());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.ask(); }
    });

    // Links rendered inside a custom view need their own click and hover handling
    root.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a.internal-link") as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      this.app.workspace.openLinkText(a.dataset.href ?? a.getAttr("href") ?? "", "", Keymap.isModEvent(e));
    });
    root.addEventListener("mouseover", (e) => {
      const a = (e.target as HTMLElement).closest("a.internal-link") as HTMLAnchorElement | null;
      if (!a) return;
      this.app.workspace.trigger("hover-link", {
        event: e, source: VIEW_TYPE, hoverParent: this, targetEl: a,
        linktext: a.dataset.href ?? a.getAttr("href") ?? "",
      });
    });

    this.checkHealth();
    this.registerInterval(window.setInterval(() => this.checkHealth(), 30_000));
  }

  focusInput() { this.input?.focus(); }

  iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
    const b = parent.createEl("button", { cls: "clickable-icon vr-icon-btn", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.onclick = onClick;
    return b;
  }

  autosize() {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(this.input.scrollHeight, 200) + "px";
  }

  async checkHealth() {
    const { ollama, weaviate } = await this.plugin.health();
    this.dot.toggleClass("is-ok", ollama && weaviate);
    this.dot.toggleClass("is-down", !ollama || !weaviate);
    const label = ollama && weaviate ? "Ollama and Weaviate reachable"
      : [!ollama && "Ollama unreachable", !weaviate && "Weaviate unreachable (is it running, or is your tunnel open?)"]
        .filter(Boolean).join(" · ");
    this.dot.setAttr("aria-label", label);
  }

  clear() {
    if (this.abort) this.abort.abort();
    this.turns = [];
    this.thread.empty();
    this.renderEmpty();
    this.focusInput();
  }

  renderEmpty() {
    const empty = this.thread.createDiv("vr-empty");
    empty.createDiv({ cls: "vr-empty-title", text: "Ask anything about your notes" });
    empty.createDiv({
      cls: "vr-empty-sub",
      text: "Answers come only from your vault, with links to the notes they used. Dates and note titles in the question pull that note in directly.",
    });
    const list = empty.createDiv("vr-suggestions");
    for (const s of SUGGESTIONS) {
      list.createEl("button", { cls: "vr-suggestion", text: s }).onclick = () => {
        this.input.value = s;
        this.ask();
      };
    }
  }

  nearBottom() { return this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight < 80; }
  scrollDown(force = false) { if (force || this.nearBottom()) this.thread.scrollTop = this.thread.scrollHeight; }

  setBusy(busy: boolean) {
    this.sendBtn.empty();
    setIcon(this.sendBtn, busy ? "square" : "arrow-up");
    this.sendBtn.toggleClass("is-busy", busy);
    this.sendBtn.setAttr("aria-label", busy ? "Stop" : "Send");
  }

  async ask() {
    if (this.abort) { this.abort.abort(); return; }  // the send button doubles as Stop
    const question = this.input.value.trim();
    if (!question) return;
    this.input.value = "";
    this.autosize();
    this.thread.querySelector(".vr-empty")?.remove();

    const turnEl = this.thread.createDiv("vr-turn");
    turnEl.createDiv({ cls: "vr-question", text: question });
    const answerWrap = turnEl.createDiv("vr-answer-wrap");
    const status = answerWrap.createDiv("vr-status");
    const spinner = status.createSpan("vr-spinner");
    setIcon(spinner, "loader-2");
    const statusText = status.createSpan();
    const answerEl = answerWrap.createDiv("vr-answer markdown-rendered");
    const sourcesEl = answerWrap.createDiv("vr-sources");
    const footer = answerWrap.createDiv("vr-footer");
    this.scrollDown(true);

    this.abort = new AbortController();
    this.setBusy(true);
    const t0 = Date.now();
    let phase = "Searching notes";
    const tick = () => statusText.setText(`${phase} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    tick();
    const timer = window.setInterval(tick, 100);

    let answer = "";
    let hits: Hit[] = [];
    let rendering = false;
    let dirty = false;
    const render = async () => {
      if (rendering) { dirty = true; return; }
      rendering = true;
      do {
        dirty = false;
        const tmp = createDiv();
        await MarkdownRenderer.render(this.app, this.linkCitations(answer, hits), tmp, "", this);
        this.decorateCitations(tmp);
        answerEl.replaceChildren(...Array.from(tmp.childNodes));
        this.scrollDown();
      } while (dirty);
      rendering = false;
    };

    try {
      hits = await this.plugin.retrieve(question);
      const tSearch = (Date.now() - t0) / 1000;
      if (!hits.length) {
        status.addClass("is-error");
        statusText.setText("Nothing found. Is the vault indexed? Try the reindex button above.");
        return;
      }
      phase = "Writing answer";
      const history = this.turns.slice(-2);
      let last = 0;
      const { tokS } = await this.plugin.chat(this.plugin.buildPrompt(question, hits), history, (t) => {
        answer += t;
        if (Date.now() - last > 120) { last = Date.now(); render(); }
      }, this.abort.signal);
      await render();
      status.remove();
      this.turns.push({ question, answer });
      this.renderSources(sourcesEl, hits, answer);
      this.renderFooter(footer, answer, hits,
        `${hits.length} sources · search ${tSearch.toFixed(1)}s · ${tokS ? tokS.toFixed(0) + " tok/s · " : ""}${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      const aborted = this.abort?.signal.aborted;
      if (answer) await render();
      status.addClass(aborted ? "is-muted" : "is-error");
      statusText.setText(aborted ? "Stopped" : this.explain(e as Error));
      spinner.remove();
      if (hits.length) this.renderSources(sourcesEl, hits, answer);
      if (aborted && answer) this.turns.push({ question, answer });
    } finally {
      window.clearInterval(timer);
      this.abort = null;
      this.setBusy(false);
      this.scrollDown();
      this.focusInput();
    }
  }

  explain(e: Error): string {
    const m = e.message;
    const s = this.plugin.settings;
    if (m.includes(s.weaviateUrl) || /ECONNREFUSED.*8080|net::ERR/.test(m))
      return `Can't reach Weaviate at ${s.weaviateUrl}. Is it running, or is your tunnel open?`;
    if (m.includes(s.ollamaUrl) || m.includes("11434"))
      return `Can't reach Ollama at ${s.ollamaUrl}. Run: brew services start ollama`;
    return `Error: ${m}`;
  }

  /** [1] or [n1] → a link to that source note; decorateCitations turns it into a pill. */
  linkCitations(answer: string, hits: Hit[]): string {
    return answer.replace(/\[n?(\d+)\]/g, (m, n) => {
      const h = hits[Number(n) - 1];
      return h ? `[[${h.source}|${n}]]` : m;
    });
  }

  decorateCitations(el: HTMLElement) {
    el.querySelectorAll("a.internal-link").forEach((a) => {
      if (/^\d+$/.test(a.textContent ?? "")) a.addClass("vr-cite");
    });
  }

  citedIndexes(answer: string): Set<number> {
    return new Set([...answer.matchAll(/\[n?(\d+)\]/g)].map((m) => Number(m[1])));
  }

  renderSources(el: HTMLElement, hits: Hit[], answer: string) {
    el.empty();
    const cited = this.citedIndexes(answer);
    const details = el.createEl("details");
    const summary = details.createEl("summary");
    summary.createSpan({ text: `Sources` });
    summary.createSpan({ cls: "vr-count", text: cited.size ? `${cited.size} cited of ${hits.length}` : `${hits.length}` });
    const list = details.createDiv("vr-source-list");
    hits.forEach((h, i) => {
      const row = list.createEl("a", { cls: "internal-link vr-source" });
      row.dataset.href = h.source;
      row.toggleClass("is-cited", cited.has(i + 1));
      row.createSpan({ cls: "vr-source-n", text: String(i + 1) });
      const body = row.createDiv("vr-source-body");
      const parts = h.source.split("/");
      const name = body.createDiv({ cls: "vr-source-name", text: parts.pop() ?? h.source });
      if (h.pinned) {
        const pin = name.createSpan({ cls: "vr-pin", attr: { "aria-label": "Named in your question" } });
        setIcon(pin, "pin");
      }
      const meta = [parts.join("/"), h.heading && h.heading !== "whole note" ? h.heading : ""].filter(Boolean).join(" › ");
      if (meta) body.createDiv({ cls: "vr-source-meta", text: meta });
    });
  }

  renderFooter(el: HTMLElement, answer: string, hits: Hit[], metrics: string) {
    el.createSpan({ cls: "vr-metrics", text: metrics });
    const actions = el.createDiv("vr-actions");
    const linked = this.linkCitations(answer, hits);
    const copy = this.iconButton(actions, "copy", "Copy answer with links", async () => {
      await navigator.clipboard.writeText(linked);
      copy.empty();
      setIcon(copy, "check");
      window.setTimeout(() => { copy.empty(); setIcon(copy, "copy"); }, 1200);
    });
    this.iconButton(actions, "text-cursor-input", "Insert into current note", () => {
      const view = this.app.workspace.getMostRecentLeaf()?.view;
      if (view instanceof MarkdownView) {
        view.editor.replaceSelection(linked + "\n");
        new Notice("Answer inserted");
      } else {
        new Notice("Open a note first");
      }
    });
  }
}

class RagSettingTab extends PluginSettingTab {
  plugin: VaultRagPlugin;
  constructor(app: App, plugin: VaultRagPlugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const text = (key: keyof Settings, name: string, desc = "") =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) => t
        .setValue(String(this.plugin.settings[key]))
        .onChange(async (v) => {
          const n = Number(v);
          (this.plugin.settings as any)[key] = typeof DEFAULTS[key] === "number"
            ? (v.trim() !== "" && !isNaN(n) ? n : DEFAULTS[key]) : v.trim();
          await this.plugin.saveSettings();
        }));
    text("ollamaUrl", "Ollama URL");
    text("weaviateUrl", "Weaviate URL", "Local, or a port-forward / tunnel when Weaviate runs in a cluster");
    text("chatModel", "Chat model");
    text("embedModel", "Embedding model", "Changing it needs a reindex");
    text("collection", "Weaviate collection");
    text("topK", "Chunks per question");
    text("alpha", "Hybrid alpha", "0 = keywords only, 1 = vectors only");
    text("maxChars", "Max characters per chunk", "Changing it needs a reindex");
    text("skipFolders", "Folders to skip when indexing", "Comma separated");
    new Setting(containerEl).setName("Live index").setDesc("Re-index a note 2 s after you create, edit, rename or delete it")
      .addToggle((t) => t.setValue(this.plugin.settings.liveIndex).onChange(async (v) => {
        this.plugin.settings.liveIndex = v;
        await this.plugin.saveSettings();
      }));
  }
}
