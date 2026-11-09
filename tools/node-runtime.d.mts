export function parseShasums(text: string): Map<string, string>;
export function nodeRuntime(version: string, arch: 'x64' | 'arm64' | string, cacheDir: string, log?: (message: string) => void): Promise<string>;
export function hostArch(): 'x64' | 'arm64';
export function runtimeInfo(dir: string): string;
