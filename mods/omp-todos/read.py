import subprocess
import json
import os
import re
import sys
from datetime import datetime

MAX_ACTIONS = 100


def parse_ms(text):
    try:
        return int(datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp() * 1000)
    except (ValueError, AttributeError):
        return None


def clip(text, size=110):
    text = ' '.join(str(text).split())
    return text if len(text) <= size else text[:size - 1] + '…'


def detail_of(name, args):
    """A short, human description of what one tool call is operating on."""
    if not isinstance(args, dict):
        return None
    if name == 'bash':
        return clip(args.get('command', ''))
    if name in ('read', 'write', 'grep', 'glob'):
        parts = [args.get('pattern'), args.get('path')]
        return clip('  '.join(str(p) for p in parts if p))
    if name == 'edit':
        match = re.search(r'\[([^\]#]+)#', args.get('input') or '')
        return clip(match.group(1)) if match else None
    if name == 'web_search':
        return clip(args.get('query', ''))
    if name == 'task':
        return clip(', '.join(t.get('name', '') for t in args.get('tasks', []) if isinstance(t, dict)))
    if name == 'todo':
        return clip(' '.join(str(args.get(k)) for k in ('op', 'task') if args.get(k)))
    if name == 'ask':
        questions = args.get('questions') or []
        return clip(next((q.get('question') for q in questions if isinstance(q, dict) and q.get('question')), ''))
    if name == 'eval':
        return args.get('language')
    return None


def file_target(name, args, base):
    if name not in ('read', 'edit', 'write') or not isinstance(args, dict):
        return None
    target = args.get('path')
    if name == 'edit':
        match = re.search(r'\[([^\]#]+)#', args.get('input') or '')
        target = match.group(1) if match else None
    if not isinstance(target, str) or re.match(r'^[a-z]+://', target):
        return None
    target = re.sub(r':(?:\d.*|raw)$', '', target)
    target = os.path.abspath(os.path.join(base, os.path.expanduser(target)))
    return target if os.path.isfile(target) else None


def context_window(pid, model):
    """Context window of a model, from OMP's catalog (cached after the first lookup)."""
    cache = os.path.expanduser('~/.cache/omp-todos-windows.json')
    try:
        with open(cache) as f:
            windows = json.load(f)
    except (OSError, ValueError):
        windows = {}
    if model not in windows:
        try:
            exe = os.path.realpath(f'/proc/{pid}/exe') if os.path.isdir('/proc') else subprocess.run(['ps', '-o', 'comm=', '-p', str(pid)], capture_output=True, text=True, timeout=5).stdout.strip()
            out = subprocess.run([exe, 'models', '--json'], capture_output=True, text=True, timeout=20).stdout
            catalog = json.loads(out)
            catalog = catalog.get('models', []) if isinstance(catalog, dict) else catalog
            windows = {m['selector']: m.get('contextWindow') for m in catalog}
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            with open(cache, 'w') as f:
                json.dump(windows, f)
        except (OSError, ValueError, subprocess.SubprocessError, KeyError):
            return None
    return windows.get(model)


def git_branch(cwd):
    try:
        out = subprocess.run(['git', '-C', cwd, 'branch', '--show-current'], capture_output=True, text=True, timeout=3).stdout.strip()
        return out or None
    except (OSError, subprocess.SubprocessError):
        return None


def session_data(path, cwd, pid):
    phases, calls, workers, model, effort = [], {}, {}, None, None
    cost, tokens = 0.0, None
    turn = {'started': None, 'actions': [], 'order': []}
    session_dir = os.path.splitext(path)[0]
    with open(path, 'rb') as f:
        for line in f:
            if not any(m in line for m in (b'"toolName"', b'"toolCall"', b'"role":"user"', b'"role":"assistant"', b'"type":"model_change"', b'"type":"thinking_level_change"')):
                continue
            try:
                record = json.loads(line)
                if record.get('type') == 'model_change':
                    model = record.get('model')
                if record.get('type') == 'thinking_level_change':
                    effort = record.get('thinkingLevel')
                msg = record.get('message') or {}
                if msg.get('role') == 'user':
                    turn = {'started': msg.get('timestamp'), 'actions': {}, 'order': []}
                if msg.get('role') == 'assistant':
                    usage = msg.get('usage') or {}
                    cost += (usage.get('cost') or {}).get('total') or 0
                    tokens = usage.get('totalTokens') or tokens
                    for call in msg.get('content', []):
                        if call.get('type') == 'toolCall':
                            calls[call.get('id')] = call
                if record.get('customType') == 'tool_execution_start':
                    data = record.get('data') or {}
                    ident = data.get('toolCallId')
                    call = calls.get(ident, {})
                    name = data.get('toolName', '')
                    args = call.get('arguments') or data.get('args') or {}
                    action = {
                        'tool': name,
                        'label': data.get('intent') or call.get('intent') or name,
                        'detail': detail_of(name, args),
                        'started': parse_ms(data.get('startedAt')),
                        'state': 'running',
                    }
                    target = file_target(name, args, cwd)
                    if target:
                        action['path'] = target
                    if name == 'ask':
                        action['reason'] = action['detail'] or 'Waiting for your answer'
                    if not isinstance(turn['actions'], dict):
                        turn['actions'] = {}
                    turn['actions'][ident] = action
                    turn['order'].append(ident)
                if msg.get('role') != 'toolResult':
                    continue
                action = turn['actions'].get(msg.get('toolCallId')) if isinstance(turn['actions'], dict) else None
                if action:
                    action['state'] = 'error' if msg.get('isError') else 'done'
                    action['ended'] = msg.get('timestamp')
                details = msg.get('details') or {}
                if msg.get('isError'):
                    continue
                if msg.get('toolName') == 'todo' and isinstance(details.get('phases'), list):
                    phases = details['phases']
                if msg.get('toolName') == 'task':
                    for job in details.get('progress', []):
                        ident = job.get('id')
                        if ident:
                            workers[ident] = {'id': ident, 'status': 'started', 'agent': job.get('agent', '')}
                for job in details.get('jobs', []):
                    ident = job.get('id')
                    if ident and (job.get('type') == 'task' or ident in workers):
                        workers.setdefault(ident, {'id': ident})
                        workers[ident]['status'] = job.get('status', 'unknown')
            except (ValueError, TypeError, AttributeError):
                continue
    for worker in workers.values():
        ident = worker['id']
        if re.fullmatch(r'[A-Za-z0-9_-]+', ident):
            report = os.path.join(session_dir, ident + '.md')
            if os.path.isfile(report):
                worker['report'] = report
                if worker['status'] == 'started':
                    worker['status'] = 'completed'
    actions = turn['actions'] if isinstance(turn['actions'], dict) else {}
    ordered = [actions[i] for i in turn['order'] if i in actions]
    counts = {}
    for action in ordered:
        counts[action['tool']] = counts.get(action['tool'], 0) + 1
    return {
        'phases': phases,
        'turn': {'started': turn['started'], 'tools': len(ordered), 'counts': counts},
        'actions': ordered[-MAX_ACTIONS:][::-1],
        'workers': list(workers.values())[::-1],
        'model': model,
        'effort': effort,
        'cost': cost,
        'tokens': tokens,
        'window': context_window(pid, (model or '').split(':')[0]) if model else None,
        'branch': git_branch(cwd),
        'cwd': cwd,
    }


def lsof_names(pid, *flags):
    """File names `lsof` reports for a process (macOS has no /proc)."""
    out = subprocess.run(['lsof', '-w', '-p', str(pid), '-Fn', *flags], capture_output=True, text=True, timeout=5).stdout
    return [line[1:] for line in out.splitlines() if line.startswith('n')]


def process_cwd(pid):
    if os.path.isdir('/proc'):
        return os.readlink(f'/proc/{pid}/cwd')
    return lsof_names(pid, '-a', '-d', 'cwd')[0]


def open_files(pid):
    if os.path.isdir('/proc'):
        root = f'/proc/{pid}/fd'
        for fd in os.listdir(root):
            try:
                yield os.readlink(f'{root}/{fd}')
            except (FileNotFoundError, PermissionError):
                continue
    else:
        yield from lsof_names(pid)


def main():
    pid = int(sys.argv[1])
    cwd = process_cwd(pid)
    for path in open_files(pid):
        if '/sessions/' in path and path.endswith('.jsonl') and os.path.isfile(path):
            print(json.dumps(session_data(path, cwd, pid)))
            return
    print(json.dumps({'error': 'OMP session is not available'}))


try:
    main()
except (ValueError, IndexError, OSError) as e:
    print(json.dumps({'error': str(e)}))
