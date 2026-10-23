# Future: Native Vector Search on the Kinetic Platform

**Status: design only. Nothing in this document is implemented.** Corporate Brain v1 uses only Kinetic KQL (equality and `=*` prefix) plus a bounded keyword scan. There is no pgvector, Pinecone, Weaviate, Chroma or any other vector store. The goal is for semantic retrieval to become a reusable **platform** capability that any kapp can use, with Corporate Brain as the first consumer.

## How it plugs into Corporate Brain
`lib/retrieval.mjs` already declares the provider:
```js
semantic: { name: "Native Kinetic semantic search", kind: "semantic", available: false }
```
When the platform API exists, a `searchSemantic(type, q, filters)` function slots in next to `searchType`. It returns the same hit shape (`{type, form, id, submissionId, title, snippet, status, date, companyId, score, matchedBy:"semantic"}`), and `search()` merges providers by score.

The UI search page, the historian (`answerSearch`, and later `findSubjects` for fuzzy names) and the agent tool `search_records` call `retrieval.search` and need **no changes**. The historian's rule stays the same: retrieval finds candidates, answers cite records, and verification remains human.

## Anticipated platform interfaces
1. **Vector index definitions on forms**, alongside `indexDefinitions`:
   ```json
   { "vectorIndexes": [{ "name": "statement", "fields": ["values[Title]", "values[Statement]"],
       "model": "space-default", "chunking": { "strategy": "none" } }] }
   ```
   Built with the existing background job pattern (`{"type":"Build Vector Index"}`), with a status of `New`, `Building` or `Built`, the same as KQL indexes.
2. **Space-level model and provider configuration:** provider, model, dimensions and credentials, held in platform secret storage, never in the kapp. The model is versioned so that a model change triggers re-embedding.
3. **Query API:** an extension of the submissions search:
   ```
   POST /app/api/v1/kapps/{kapp}/forms/{form}/submissions/semantic
   { "query": "how did the Vattenfall relationship start", "index": "statement",
     "q": "values[Company ID] = \"CO-…\" AND values[Review Status] = \"verified\"",   // KQL pre-filter (hybrid)
     "limit": 25, "include": "values" }
   → { "submissions": [...], "scores": [...], "nextPageToken": … }
   ```
   A kapp-wide variant would search every form in the kapp that has a compatible index.
4. **Hybrid ranking:** the KQL filter runs first, using the same indexes as today; the vector similarity search runs within that set; there is an optional keyword or BM25 blend; and results keep the 25-per-page pagination.

## Embedding lifecycle
| Event | Platform action |
|---|---|
| Submission created | Embed the indexed fields asynchronously. The record is searchable once embedding finishes, and status is visible per index. |
| Submission updated | Re-embed only when an indexed field changed (compare content hashes). |
| Submission deleted | Remove its vectors in the same transaction or job. Deleted records must never be returned. |
| Model or version change | Background re-embed of the whole index, with old vectors served until the switch. |
| Field or index definition change | Rebuild that index. |

## Permissions (non-negotiable)
Retrieval must apply the **same `Submission Access` evaluation as a normal query**, including form overrides such as `CB Restricted Source`. A restricted source must never surface as a hit, a snippet or a score. That means filtering inside the engine before results are returned, not trusting the caller to filter. Corporate Brain will keep calling with the end user's credentials.

## What to embed in Corporate Brain
- **Knowledge entries:** Title and Statement, as one vector per entry (short text, no chunking).
- **Sources:** Title and Excerpt only, which is what Corporate Brain stores. Full documents stay in their systems. Embedding full originals would require connector-side chunking under the source system's permissions, which is out of scope until there is a governance design for archival copies.
- **Companies and people:** Name, Aliases and Description, for fuzzy entity resolution (for example "Vattenfal", or a Swedish spelling).
- **Events and decisions:** Title, Description, Context and Rationale.

## Evaluation before enabling
- Build a gold set of historical questions such as "Which prior proposals resemble the Oregon RFP?" and "Which customers used Kinetic for employee onboarding?", each with expected records.
- Compare keyword-only, semantic-only and hybrid retrieval on recall@25 and precision.
- Check for permission leakage with restricted fixtures and non-reviewer users. Any leak fails the evaluation.
- Measure latency and cost for embedding and querying at 10k, 100k and 1M submissions.

## Explicitly out of scope for v1
Embeddings, vector storage, similarity queries, chunking pipelines and any external vector database.
