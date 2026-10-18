/**
 * Upload + parse attached documents.
 *
 * Extracted from IntelligenceDashboard so the intake screen and the "add sources" dialog
 * share one implementation. The one-request-per-file loop is load-bearing, not incidental:
 * Vercel caps a request body at ~4.5 MB, so five 4 MB files cannot be batched.
 *
 * A file that fails to parse is reported and skipped. It must never block the analysis the
 * founder actually asked for.
 */
import toast from 'react-hot-toast';
import { authenticatedFetch } from './apiClient';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * @returns {Promise<{ docs: Array, text: string|null }>} parsed documents and their fused
 *          text, or `text: null` when nothing could be read.
 */
export async function uploadAndParseDocuments(files, { onStatus, clientId, websiteUrl, ingestForRag = true } = {}) {
    const parsedDocs = [];
    if (!files || files.length === 0) return { docs: [], text: null };

    for (const [index, file] of Array.from(files).entries()) {
        onStatus?.(`Reading ${file.name} (${index + 1} of ${files.length})...`);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const uploadRes = await authenticatedFetch(`${API_BASE}/upload`, { method: 'POST', body: formData });

            if (!uploadRes.ok) {
                const err = await uploadRes.json().catch(() => ({}));
                console.warn(`Document extraction failed for ${file.name}:`, err.error);
                toast.error(err.error || `Could not read ${file.name}.`);
                continue;
            }

            const uploadData = await uploadRes.json();
            for (const doc of uploadData.documents || []) {
                parsedDocs.push(doc);

                const q = doc.quality || {};
                if (q.pagesRecoveredByVision > 0) {
                    toast.success(`${doc.fileName}: recovered ${q.pagesRecoveredByVision} scanned page(s).`);
                }
                if (q.pagesUnreadable > 0) {
                    toast(`${doc.fileName}: ${q.pagesUnreadable} page(s) could not be read.`, { icon: '⚠️' });
                }

                // RAG: chunk + embed + store for grounded Q&A. Non-blocking —
                // retrieval quality is a bonus, not a gate on analysis.
                if (ingestForRag && clientId && doc.text) {
                    import('./ragService')
                        .then(({ ingestDocument }) => ingestDocument({
                            clientId,
                            websiteUrl,
                            sourceName: doc.fileName || 'uploaded-document',
                            text: doc.text,
                        }))
                        .catch(e => console.warn('RAG ingest skipped:', e.message));
                }
            }
            for (const failure of uploadData.failures || []) {
                toast.error(failure.error || `Could not read ${failure.filename}.`);
            }
        } catch (e) {
            console.warn(`Document upload error for ${file.name}:`, e.message);
            toast.error(`Could not upload ${file.name}.`);
        }
    }

    const text = parsedDocs.length > 0
        ? parsedDocs.map(d => `━━━ ${d.fileName} ━━━\n${d.text}`).join('\n\n')
        : null;

    if (parsedDocs.length > 0) {
        const totalChars = parsedDocs.reduce((n, d) => n + d.charCount, 0);
        onStatus?.(`Read ${parsedDocs.length} document(s) — ${totalChars.toLocaleString()} chars...`);
    }

    return { docs: parsedDocs, text };
}
