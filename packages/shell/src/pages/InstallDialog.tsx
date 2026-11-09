import { useState } from 'react';
import { Button, Dialog, FileUploader, Input, MessageStrip, RadioGroup, Stack, Text } from '@enterprise-ui/react';
import { ApiRequestError, ErrorMessage, api, request } from '@servermin/client';

type Source = 'directory' | 'archive' | 'git';

/** Install a new module, or update an existing one when `moduleId` is given (§34). */
export function InstallDialog({ open, onClose, onDone, moduleId, initialPath }: { open: boolean; onClose: () => void; onDone: (warnings: string[]) => void; moduleId?: string; initialPath?: string }) {
  const [source, setSource] = useState<Source>(initialPath ? 'directory' : 'archive');
  const [path, setPath] = useState(initialPath ?? '');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [sha256, setSha256] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const base = moduleId ? `/api/v1/platform/modules/${moduleId}` : '/api/v1/platform/modules';

  const finish = (r: { warnings?: string[] }) => {
    setBusy(false);
    onDone(r.warnings ?? []);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = source === 'git' ? { source, url, ref: ref || undefined } : { source: 'directory', path };
      finish(await api.post(moduleId ? `${base}/update` : base, body));
    } catch (e) {
      setError(e as Error);
      setBusy(false);
    }
  };

  const upload = async (file: File, ctx: { signal: AbortSignal; onProgress: (n: number) => void }) => {
    setError(null);
    try {
      ctx.onProgress(0.1);
      const r = await request(`${base}/upload`, { method: 'POST', raw: file, query: { sha256: sha256 || undefined }, signal: ctx.signal });
      ctx.onProgress(1);
      finish(r);
    } catch (e) {
      setError(e as Error);
      throw e instanceof ApiRequestError ? new Error(e.message) : e;
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={moduleId ? `Update ${moduleId}` : 'Install module'}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {source !== 'archive' ? (
            <Button variant="primary" loading={busy} disabled={source === 'git' ? !url : !path} onClick={() => void submit()}>
              {moduleId ? 'Update' : 'Install'}
            </Button>
          ) : null}
        </>
      }
    >
      <Stack gap={4}>
        <RadioGroup
          label="Source"
          orientation="horizontal"
          value={source}
          onChange={(v) => setSource(v as Source)}
          options={[
            { value: 'archive', label: 'Package (.tgz)' },
            { value: 'directory', label: 'Local directory' },
            { value: 'git', label: 'Git repository' },
          ]}
        />
        {source === 'archive' ? (
          <>
            <Input label="SHA-256 checksum" description="Optional. The upload is rejected if the archive does not match." value={sha256} onChange={(e) => setSha256(e.target.value.trim())} className="sm-mono" />
            <FileUploader label="Drop a module package here, or browse" accept={['.tgz', '.tar.gz', 'application/gzip']} maxFileSize={200 * 1024 * 1024} upload={upload} />
            <Text size="sm" tone="secondary">
              Packages must contain module.json and an integrity.json listing the SHA-256 of every file. Build them with <code>node tools/build-module.mjs &lt;dir&gt; --pack</code>.
            </Text>
          </>
        ) : null}
        {source === 'directory' ? (
          <Input label="Directory on the server" description="An absolute path containing module.json and its built files." value={path} onChange={(e) => setPath(e.target.value)} placeholder="/opt/servermin/modules/example" required />
        ) : null}
        {source === 'git' ? (
          <>
            <Input label="Repository URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/example/servermin-module.git" required />
            <Input label="Branch or tag" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" />
            <MessageStrip tone="information">The repository must contain the built module (module.json and dist/). Git must be installed on the server.</MessageStrip>
          </>
        ) : null}
        {error ? <ErrorMessage error={error} title={moduleId ? 'Update failed' : 'Installation failed'} /> : null}
      </Stack>
    </Dialog>
  );
}
