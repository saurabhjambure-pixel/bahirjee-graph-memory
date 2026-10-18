/**
 * Add a product.
 *
 * Saving does NOT spend a run. A target is a durable record the founder can add now and
 * research later — charging a credit for describing your own product would make the
 * obvious first action the expensive one.
 */
import React, { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import DocumentDropzone from './DocumentDropzone';
import { createTarget } from '../../services/targetService';
import { validateWebsiteUrl } from '../../utils/urlValidation';

export default function TargetSetupScreen({
    clientId,
    targetDomain,
    parentTargetId,
    onSaved,
    onCancel,
}) {
    const [name, setName] = useState('');
    const [canonicalUrl, setCanonicalUrl] = useState('');
    const [files, setFiles] = useState([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [urlError, setUrlError] = useState(null);
    // Set only when createTarget created the row but could not finish it (context
    // inheritance or the draft→active promotion failed). Resubmitting the same name
    // would now hit the unique-slug path, so "Save product" is no longer a way forward —
    // see the branch below.
    const [partial, setPartial] = useState(null);

    const canSave = name.trim().length > 0 && canonicalUrl.trim().length > 0 && !saving && !partial;

    const handleSave = async () => {
        setError(null);
        setUrlError(null);

        // type="url" with no <form> and a type="button" submit never triggers the
        // browser's native URL validation — it only changes the mobile keyboard here.
        // Validate explicitly with the same helper the intake screen uses, and submit
        // the normalized value it returns, not the raw string.
        const validation = validateWebsiteUrl(canonicalUrl);
        if (!validation.ok) {
            setUrlError(validation.message);
            return;
        }

        setSaving(true);
        const result = await createTarget({
            clientId,
            type: 'product',
            name,
            targetDomain,
            parentTargetId,
            sources: {
                canonicalUrl: validation.normalized,
                documents: files.map((f) => ({
                    name: f.name,
                    uploaded_at: new Date().toISOString(),
                    size: f.size,
                })),
            },
        });
        setSaving(false);

        if (result.ok) {
            onSaved?.(result.target);
            return;
        }

        if (result.target) {
            // Created, but not yet runnable. The founder is not stuck redoing the form —
            // they're stuck if we let them try "Save product" again, since that now hits
            // "A target with that name already exists" and contradicts createTarget's own
            // "try again in a moment" message.
            setPartial({ target: result.target, message: result.message });
            return;
        }

        setError(result.message);
    };

    return (
        <div className="min-h-dvh flex flex-col">
            <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-6 space-y-5">
                <button
                    type="button"
                    onClick={onCancel}
                    className="bah-button-ghost text-xs px-2 py-1 flex items-center gap-1"
                    aria-label="Go back"
                >
                    <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                    Back
                </button>

                <div>
                    <h1 className="text-lg font-display text-bah">Add a product</h1>
                    <p className="text-sm text-bah-muted leading-relaxed mt-1">
                        I'll start from what I already know about your company, then watch this
                        product's category, pricing and rivals separately. Saving doesn't use a run.
                    </p>
                </div>

                <div className="bah-panel p-4 space-y-4">
                    <div>
                        <label htmlFor="target-name" className="block text-xs text-bah-muted mb-1">
                            What's it called?
                        </label>
                        <input
                            id="target-name"
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="bah-input w-full"
                            placeholder="Widget Pro"
                        />
                    </div>

                    <div>
                        <label htmlFor="target-url" className="block text-xs text-bah-muted mb-1">
                            A page I can read
                        </label>
                        <input
                            id="target-url"
                            type="url"
                            value={canonicalUrl}
                            onChange={(e) => {
                                setCanonicalUrl(e.target.value);
                                if (urlError) setUrlError(null);
                            }}
                            className="bah-input w-full"
                            placeholder="https://acme.com/widget-pro"
                            aria-invalid={urlError ? 'true' : undefined}
                            aria-describedby={urlError ? 'target-url-error' : 'target-url-hint'}
                        />
                        {urlError ? (
                            <p id="target-url-error" role="alert" className="text-xs text-bah-danger mt-1">
                                {urlError}
                            </p>
                        ) : (
                            <p id="target-url-hint" className="text-xs text-bah-muted mt-1">
                                The product page, or its pricing page — whichever says most.
                            </p>
                        )}
                    </div>

                    <div>
                        <span className="block text-xs text-bah-muted mb-1">
                            Anything else I should read (optional)
                        </span>
                        <DocumentDropzone
                            files={files}
                            setFiles={setFiles}
                            inputId="target-file-input"
                            hint="Drag & drop or click to upload"
                        />
                    </div>
                </div>

                {partial ? (
                    <div className="bah-panel p-4 space-y-3">
                        <p role="alert" className="text-sm text-bah-danger">{partial.message}</p>
                        <p className="text-xs text-bah-muted leading-relaxed">
                            {partial.target.name} is saved as a draft. Saving it again here won't
                            work — that name is already taken — but nothing was lost. Continue and
                            it'll be waiting in your list to finish setting up.
                        </p>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => onSaved?.(partial.target)}
                                className="bah-button-primary text-sm px-4 py-2"
                            >
                                Continue
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        {error && (
                            <p role="alert" className="text-sm text-bah-danger">{error}</p>
                        )}

                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={!canSave}
                                className="bah-button-primary text-sm px-4 py-2 flex items-center gap-2 disabled:opacity-50"
                            >
                                {saving && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                                Save product
                            </button>
                            <button type="button" onClick={onCancel} className="bah-button-ghost text-sm px-3 py-2">
                                Cancel
                            </button>
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}
