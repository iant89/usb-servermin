/**
 * A PTY bridge in Python (standard library only). It forks a login shell on a pseudo-terminal,
 * copies stdin → pty and pty → stdout, and reads JSON control messages (resize) from fd 3.
 * Using Python avoids shipping a native Node addon on a portable installation.
 */
export const PTY_BRIDGE = String.raw`import os, sys, pty, select, json, fcntl, termios, struct, signal

shell = sys.argv[1] if len(sys.argv) > 1 else "/bin/bash"
rows, cols = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (24, 80)
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ.pop("SERVERMIN_MODULE", None)
    try:
        os.chdir(os.path.expanduser("~"))
    except OSError:
        os.chdir("/")
    os.execvp(shell, [shell, "-l"])

def resize(r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(1, min(r, 500)), max(1, min(c, 1000)), 0, 0))
    try:
        os.kill(pid, signal.SIGWINCH)
    except OSError:
        pass

resize(rows, cols)
CTRL = 3
watch = [fd, 0, CTRL]
pending = b""
while True:
    try:
        readable, _, _ = select.select(watch, [], [])
    except InterruptedError:
        continue
    if fd in readable:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in readable:
        data = os.read(0, 65536)
        if not data:
            os.kill(pid, signal.SIGHUP)
            break
        while data:
            n = os.write(fd, data)
            data = data[n:]
    if CTRL in readable:
        data = os.read(CTRL, 4096)
        if not data:
            watch.remove(CTRL)
            continue
        pending += data
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            try:
                msg = json.loads(line)
                if msg.get("type") == "resize":
                    resize(int(msg["rows"]), int(msg["cols"]))
            except (ValueError, KeyError):
                pass
try:
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)
except ChildProcessError:
    sys.exit(0)
`;
