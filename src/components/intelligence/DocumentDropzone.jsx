/**
 * Document picker + validation, shared by the intake screen and the add-sources dialog.
 *
 * Extracted rather than copied: the accepted extensions, the 4 MB per-file cap and the
 * five-file limit all have to agree with what /api/upload will actually accept, and two
 * copies of that list drift the moment one of them changes.
 */
import React from 'react';
import toast from 'react-hot-toast';
import { CheckCircle, X } from 'lucide-react';

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'tiff', 'gif', 'bmp'];

/** Validate an incoming FileList against the existing selection. Pure. */
export function acceptFiles(incoming, existing) {
    const accepted = [];
    for (const file of incoming) {
        const ext = file.name.toLowerCase().split('.').pop();
        if (!ACCEPTED_EXTENSIONS.includes(ext)) {
            toast.error(`${file.name}: unsupported type. Accepted: PDF, Word, or images.`);
            continue;
        }
        if (file.size > MAX_FILE_BYTES) {
            toast.error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 4 MB per file.`);
            continue;
        }
        if ([...existing, ...accepted].some(f => f.name === file.name && f.size === file.size)) continue;
        accepted.push(file);
    }
    const room = MAX_FILES - existing.length;
    if (accepted.length > room) toast.error(`You can attach up to ${MAX_FILES} documents.`);
    return room > 0 ? [...existing, ...accepted.slice(0, room)] : existing;
}

export default function DocumentDropzone({ files, setFiles, inputId = 'file-upload-input', hint }) {
    const onDrop = (e) => {
        e.preventDefault();
        const incoming = Array.from(e.dataTransfer?.files || e.target?.files || []);
        if (incoming.length === 0) return;
        setFiles(acceptFiles(incoming, files));
        // Let the same file be re-selected after removal.
        if (e.target) e.target.value = '';
    };

    return (
        <label
            htmlFor={inputId}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className={`block bg-bah-panel rounded-xl border-2 border-dashed transition-colors p-3 tall:p-5 text-center cursor-pointer hover:border-[var(--bah-accent)]/50 focus-within:border-[var(--bah-accent)]/50 focus-within:ring-1 focus-within:ring-[var(--bah-accent)]/40 ${files.length > 0 ? 'border-emerald-500/40' : 'border-bah'}`}
        >
            <input
                id={inputId}
                type="file"
                multiple
                accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.tiff,.gif,.bmp"
                className="sr-only"
                onChange={onDrop}
            />
            {files.length > 0 ? (
                <div className="space-y-2">
                    {files.map((file, i) => (
                        <div key={`${file.name}-${file.size}`} className="flex items-center justify-center gap-3">
                            <CheckCircle className="w-5 h-5 text-bah-accent-strong shrink-0" />
                            <span className="text-bah-accent-strong text-sm font-medium truncate max-w-[16rem]">{file.name}</span>
                            <span className="text-bah-muted text-xs shrink-0">({(file.size / 1024).toFixed(0)} KB)</span>
                            <button
                                type="button"
                                aria-label={`Remove ${file.name}`}
                                onClick={(e) => { e.stopPropagation(); setFiles(files.filter((_, idx) => idx !== i)); }}
                                className="text-bah-muted hover:text-bah-danger transition-colors shrink-0"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                    ))}
                    {files.length < MAX_FILES && (
                        <p className="text-bah-muted-2 text-xs pt-1">Click to add another ({MAX_FILES - files.length} remaining)</p>
                    )}
                </div>
            ) : (
                <div className="space-y-2">
                    <p className="text-bah-muted text-sm">{hint || 'Drag & drop or click to upload'}</p>
                    <p className="text-bah-muted-2 text-xs">PDF, Word, or images • Max 4 MB each • Up to {MAX_FILES} files</p>
                </div>
            )}
        </label>
    );
}
