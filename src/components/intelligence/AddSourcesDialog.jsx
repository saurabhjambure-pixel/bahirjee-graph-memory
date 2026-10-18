/**
 * Add new pages and documents to a context we already have.
 *
 * Sits over the gate rather than replacing it, so the founder never loses sight of the
 * context they are augmenting. It reads ONLY what is added here — no Tavily searches, no
 * LinkedIn re-fetch, no re-crawl of the company site — which is the entire difference in
 * cost between this and "Rebuild from scratch".
 */
import React, { useState } from 'react';
import { Plus, X, Link2, Loader2, FilePlus2 } from 'lucide-react';
import Modal from '../common/Modal';
import DocumentDropzone, { MAX_FILES } from './DocumentDropzone';
import { validateWebsiteUrl } from '../../utils/urlValidation';

const MAX_URLS = 5;

export default function AddSourcesDialog({ open, onClose, onSubmit, busy = false }) {
    const [urls, setUrls] = useState(['']);
    const [files, setFiles] = useState([]);
    const [errors, setErrors] = useState({});

    const setUrlAt = (i, value) => {
        setUrls(urls.map((u, idx) => (idx === i ? value : u)));
        if (errors[i]) setErrors({ ...errors, [i]: null });
    };

    const filled = urls.map(u => u.trim()).filter(Boolean);
    const canSubmit = !busy && (filled.length > 0 || files.length > 0);

    const submit = () => {
        // Validate with the same helper intake uses, so a URL that is fine on one screen is
        // never rejected on the other.
        const nextErrors = {};
        const valid = [];
        urls.forEach((raw, i) => {
            const trimmed = raw.trim();
            if (!trimmed) return;
            const result = validateWebsiteUrl(trimmed);
            if (!result.ok) nextErrors[i] = result.message || 'That does not look like a URL.';
            else valid.push(result.normalized || trimmed);
        });
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;
        onSubmit({ urls: valid, files });
    };

    return (
        <Modal
            open={open}
            onClose={busy ? () => {} : onClose}
            title="Add sources to this context"
            description="Bahirjee reads only what you add here and folds it into what it already knows. Anything you corrected by hand stays as you set it."
        >
            <div className="space-y-5">
                <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-bah-muted flex items-center gap-1.5 mb-2">
                        <Link2 className="w-3 h-3" /> Pages to read
                    </label>
                    <div className="space-y-2">
                        {urls.map((url, i) => (
                            <div key={i}>
                                <div className="flex items-center gap-2">
                                    <input
                                        value={url}
                                        onChange={(e) => setUrlAt(i, e.target.value)}
                                        placeholder="https://company.com/pricing"
                                        disabled={busy}
                                        className="bah-input rounded-lg px-3 py-2 text-sm"
                                    />
                                    {urls.length > 1 && (
                                        <button
                                            type="button"
                                            aria-label={`Remove URL ${i + 1}`}
                                            onClick={() => setUrls(urls.filter((_, idx) => idx !== i))}
                                            disabled={busy}
                                            className="text-bah-muted hover:text-bah-danger transition-colors shrink-0 p-1"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                                {errors[i] && <p className="text-[11px] text-bah-danger mt-1">{errors[i]}</p>}
                            </div>
                        ))}
                    </div>
                    {urls.length < MAX_URLS && (
                        <button
                            type="button"
                            onClick={() => setUrls([...urls, ''])}
                            disabled={busy}
                            className="mt-2 text-xs text-bah-accent hover:text-bah-accent-strong flex items-center gap-1"
                        >
                            <Plus className="w-3 h-3" /> Add another page
                        </button>
                    )}
                </div>

                <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-bah-muted flex items-center gap-1.5 mb-2">
                        <FilePlus2 className="w-3 h-3" /> Documents
                    </label>
                    <DocumentDropzone
                        files={files}
                        setFiles={setFiles}
                        inputId="add-sources-file-input"
                        hint={`Drag & drop or click to add up to ${MAX_FILES} documents`}
                    />
                </div>

                <div className="flex justify-end gap-2 pt-1">
                    <button onClick={onClose} disabled={busy} className="bah-button-secondary px-4 py-2 text-sm">
                        Cancel
                    </button>
                    <button
                        onClick={submit}
                        disabled={!canSubmit}
                        className="bah-button-primary px-4 py-2 text-sm flex items-center gap-2"
                    >
                        {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Reading…</> : 'Read and merge'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
