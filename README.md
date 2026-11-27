# Vault RAG for Obsidian

Ask questions about your Obsidian vault and get answers that cite the notes they come from. Everything runs on infrastructure you control: [Ollama](https://ollama.com) for the language model and embeddings, [Weaviate](https://weaviate.io) for vector search.

The plugin opens a chat panel in the right sidebar. You type a question, the answer streams in, and each citation like `[1]` is a link to the note it came from.

## How it works

```
                 ┌───────────── Obsidian ─────────────┐
 your notes ───▶ │ chunk on headings and callouts     │
                 │ (max 1,500 characters)             │
                 └──────────────┬─────────────────────┘
                                │ "path › heading\ntext"
                                ▼
                     Ollama  nomic-embed-text  (768-dim vectors)
                                │
                                ▼
                     Weaviate  collection "Vault"  (vectorizer: none)

 question ──▶ embed ──▶ hybrid search (BM25 + vector) ─┐
          └─▶ notes named in the question (dates, titles) ──┤
                                                         ▼
                       prompt: "use only this context, cite [n]"
                                                         ▼
                     Ollama  qwen3:8b  ──▶ streamed answer with links
```

1. **Indexing.** Each note is split on headings and callouts. Each chunk is embedded together with its note path and heading, so a daily note named `2026-11-27` can be found by its date even if the date never appears in its text. Vectors are computed by Ollama and sent to Weaviate as-is.
2. **Live updates.** Two seconds after a note is created, edited, renamed or deleted, its chunks are deleted from Weaviate (filter on `source`) and inserted again. No full reindex is needed after the first one.
3. **Retrieval.** The question is embedded and sent to Weaviate as a **hybrid** query: keyword search (BM25) on text, path and heading, combined with vector similarity (`alpha` 0.5 by default). Pure vector search misses notes whose key information is only in the filename, and keywords fix that.
4. **Named notes.** If the question says *today*, *tomorrow*, *yesterday* (also in French), contains a date like `2026-11-27`, or contains a note's exact title, that whole note is added as source `[1]`.
5. **Answer.** The top chunks go into a prompt that tells the model to use only that context, cite `[n]`, and say when the answer isn't there. The last two question/answer pairs are sent too, so follow-up questions work. The answer is rendered as Markdown while it streams.

## Features

- Chat panel with streaming answers, a Stop button, and follow-up questions
- Citation pills that open the note. Cmd/Ctrl + hover shows a preview
- Sources under each answer, with cited notes highlighted
- Copy an answer with its `[[links]]`, or insert it into the open note
- Status light showing whether Ollama and Weaviate are reachable
- Commands: **Ask vault**, **Reindex vault**, **Index current note**
- Settings: URLs, models, chunks per question, hybrid alpha, chunk size, skipped folders, live index on/off

## Requirements

- Obsidian desktop. The plugin is marked desktop-only because it calls local services
- [Ollama](https://ollama.com) with a chat model and an embedding model:
  ```bash
  ollama pull qwen3:8b
  ollama pull nomic-embed-text
  ```
- Weaviate 1.25 or newer, reachable over HTTP. Any of these works:
  - **Docker:** `docker run -d -p 8080:8080 -p 50051:50051 cr.weaviate.io/semitechnologies/weaviate:1.41.0`
  - **Kubernetes:** `helm repo add weaviate https://weaviate.github.io/weaviate-helm && helm install weaviate weaviate/weaviate -n weaviate --create-namespace -f deploy/weaviate-values.yaml`, then a port-forward or tunnel to `127.0.0.1:8080`

## Install

```bash
git clone https://github.com/joesabbagh1/obsidian-vault-rag.git
cd obsidian-vault-rag
npm install
VAULT=/path/to/your/vault npm run install-plugin
```

Then in Obsidian: **Settings → Community plugins → reload → enable Vault RAG**, open the panel from the ribbon, and run **Reindex vault** once. A vault of about 1,250 notes (8,500 chunks) takes 8 minutes on an M1 Pro. Embedding is the bottleneck, not Weaviate.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Ollama URL | `http://127.0.0.1:11434` | |
| Weaviate URL | `http://127.0.0.1:8080` | |
| Chat model | `qwen3:8b` | Thinking is turned off for speed |
| Embedding model | `nomic-embed-text` | Changing it needs a reindex |
| Weaviate collection | `Vault` | |
| Chunks per question | `6` | |
| Hybrid alpha | `0.5` | `0` = keywords only, `1` = vectors only |
| Max characters per chunk | `1500` | Changing it needs a reindex |
| Folders to skip | `templates` | Comma separated |
| Live index | on | |

## Measured on a MacBook Pro M1 Pro (16 GB)

| | |
|---|---|
| Full index | 8,580 chunks from 1,247 notes in about 8.5 min |
| Search | 0.25–2 s, depending on the network path to Weaviate |
| Generation | 17–21 tokens/s with `qwen3:8b` (Q4, 5.2 GB) |
| Typical answer | 12–19 s end to end |
| Weaviate memory | about 200 MB for 9,000 vectors of 768 dimensions |

## Privacy

Your notes are sent only to the Ollama and Weaviate URLs you configure. If both run on your machine, nothing leaves it. If Weaviate runs elsewhere (a cluster, a VM), the text of every indexed note is stored there. Use **Folders to skip** for anything that must stay local, and enable Weaviate authentication when it's reachable from a network. The plugin doesn't send an API key yet.

## Development

```bash
npm run build                                  # type-check + bundle to main.js
VAULT=/path/to/vault npm run install-plugin    # build and copy into the vault
```

Then toggle the plugin off and on in Obsidian to load the new build. Everything is in `src/main.ts` and `styles.css`. All HTTP calls use Obsidian's `requestUrl`, except streaming chat, which uses `fetch` (Ollama allows the `app://obsidian.md` origin).

## License

MIT
