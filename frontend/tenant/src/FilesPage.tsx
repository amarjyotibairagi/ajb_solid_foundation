import { useEffect, useRef, useState } from 'react'

type StoredFile = { id: string; fileName: string; contentType: string; sizeBytes: number; storage: 'vds' | 'external'; createdAt: string }
type Listing = { files: StoredFile[]; usage: Array<{ backend: string; files: number; bytes: number }>; limits: { maxFileMb: number; quotaMb: number }; activeBackend: 'vds' | 'external' }

const button: React.CSSProperties = { padding: '6px 12px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#fff', cursor: 'pointer', fontSize: '13px' }
const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`)

/** Workspace files, stored on the platform (VDS) or the workspace's own bucket. */
export function FilesPage({ csrfToken, accent }: { csrfToken: string | null; accent: string }) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const load = async () => {
    const response = await fetch('/api/v1/files', { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) {
      setMessage({ tone: 'error', text: data.message || 'Files are unavailable.' })
      return
    }
    setListing(data)
  }
  useEffect(() => { void load() }, [])

  const upload = async (file: File) => {
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/v1/files', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          'X-Content-Type': file.type || 'application/octet-stream',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        body: file,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || 'Upload failed.')
      setMessage({ tone: 'success', text: `Uploaded ${data.file.fileName}.` })
      await load()
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const remove = async (file: StoredFile) => {
    if (!window.confirm(`Delete ${file.fileName}?`)) return
    const response = await fetch(`/api/v1/files/${file.id}`, { method: 'DELETE', credentials: 'include', headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {} })
    const data = await response.json()
    setMessage(response.ok ? { tone: 'success', text: 'Deleted.' } : { tone: 'error', text: data.message || 'Delete failed.' })
    await load()
  }

  const totalBytes = listing?.usage.reduce((sum, item) => sum + item.bytes, 0) ?? 0
  return (
    <div style={{ maxWidth: '900px' }}>
      <h2 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 6px' }}>Files</h2>
      {listing && (
        <p style={{ margin: '0 0 16px', fontSize: '13px', color: '#64748b' }}>
          New files are stored {listing.activeBackend === 'vds' ? 'on the platform' : "in your organization's own bucket"}. {formatBytes(totalBytes)} used
          {listing.limits.quotaMb ? ` of ${listing.limits.quotaMb} MB` : ''}; files up to {listing.limits.maxFileMb} MB.
        </p>
      )}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '14px' }}>
        <input ref={input} type="file" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file) }} />
        {busy && <span style={{ fontSize: '13px', color: '#64748b' }}>Uploading…</span>}
      </div>
      {message && <div style={{ marginBottom: '12px', fontSize: '13px', color: message.tone === 'error' ? '#b91c1c' : '#166534' }}>{message.text}</div>}
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead><tr style={{ textAlign: 'left', color: '#475569', background: '#f8fafc' }}><th style={{ padding: '10px' }}>Name</th><th>Size</th><th>Stored</th><th>Added</th><th /></tr></thead>
          <tbody>
            {listing?.files.map((file) => (
              <tr key={file.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                <td style={{ padding: '10px' }}>{file.fileName}</td>
                <td>{formatBytes(file.sizeBytes)}</td>
                <td>{file.storage === 'vds' ? 'Platform' : 'Your bucket'}</td>
                <td>{new Date(file.createdAt).toLocaleString()}</td>
                <td style={{ textAlign: 'right', padding: '10px', whiteSpace: 'nowrap' }}>
                  <a href={`/api/v1/files/${file.id}`} style={{ ...button, textDecoration: 'none', color: accent }}>Download</a>{' '}
                  <button style={button} onClick={() => void remove(file)}>Delete</button>
                </td>
              </tr>
            ))}
            {listing && !listing.files.length && <tr><td style={{ padding: '14px', color: '#94a3b8' }} colSpan={5}>No files yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
