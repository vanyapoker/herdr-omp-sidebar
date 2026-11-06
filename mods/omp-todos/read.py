import time
import subprocess
import json
import os
import re
import sys
from datetime import datetime

MAX_ACTIONS = 100
BODY_ACTIONS = 40


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

def args_text(name, args, limit=1500):
    """The call's arguments as plain text, for the detail viewer."""
    if not isinstance(args, dict):
        return ''
    text = args.get('command') if name == 'bash' else args.get('input') if name == 'edit' else None
    if not isinstance(text, str):
        text = json.dumps(args, indent=1, ensure_ascii=False)
    return text if len(text) <= limit else text[:limit] + '\n… (truncated)'


def result_text(msg, limit=1500):
    content = msg.get('content')
    if isinstance(content, list):
        content = '\n'.join(c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text')
    if not isinstance(content, str):
        return ''
    return content if len(content) <= limit else content[:limit] + '\n… (truncated)'


def worker_activity(path):
    """Tool count, current and latest tool of one subagent's transcript."""
    labels, order, finished = {}, [], set()
    try:
        with open(path, 'rb') as f:
            for line in f:
                try:
                    if b'"tool_execution_start"' in line:
                        data = json.loads(line).get('data') or {}
                        labels[data.get('toolCallId')] = data.get('intent') or data.get('toolName')
                        order.append(data.get('toolCallId'))
                    elif b'"role":"toolResult"' in line:
                        finished.add((json.loads(line).get('message') or {}).get('toolCallId'))
                except (ValueError, AttributeError):
                    continue
    except OSError:
        return {}
    pending = [i for i in order if i not in finished]
    return {'tools': len(order), 'current': labels[pending[-1]] if pending else None, 'last': labels[order[-1]] if order else None}


def omp_exe(pid):
    if os.path.isdir('/proc'):
        return os.path.realpath(f'/proc/{pid}/exe')
    return subprocess.run(['ps', '-o', 'comm=', '-p', str(pid)], capture_output=True, text=True, timeout=5).stdout.strip()


def usage_limits(pid, provider, ttl=60):
    """Rate-limit windows (5 hours, 7 days, ...) of the provider's account, from `omp usage`; cached for a minute."""
    cache = os.path.expanduser('~/.cache/omp-todos-usage.json')
    try:
        with open(cache) as f:
            saved = json.load(f)
    except (OSError, ValueError):
        saved = {}
    entry = saved.get(provider)
    if entry and time.time() - entry['at'] < ttl:
        return entry['limits']
    try:
        out = subprocess.run([omp_exe(pid), 'usage', '--json', '--provider', provider], capture_output=True, text=True, timeout=20).stdout
        limits = []
        for report in json.loads(out).get('reports', []):
            if report.get('provider') != provider:
                continue
            for limit in report.get('limits', []):
                amount, window = limit.get('amount') or {}, limit.get('window') or {}
                if amount.get('usedFraction') is None:
                    continue
                limits.append({
                    'label': window.get('label') or limit.get('label'),
                    'window': window.get('id'),
                    'used': amount['usedFraction'],
                    'unit': amount.get('unit'),
                    'remaining': amount.get('remaining'),
                    'limit': amount.get('limit'),
                    'resetsAt': window.get('resetsAt'),
                    'status': limit.get('status'),
                })
            break
        saved[provider] = {'at': time.time(), 'limits': limits}
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, 'w') as f:
            json.dump(saved, f)
        return limits
    except (OSError, ValueError, subprocess.SubprocessError):
        return entry['limits'] if entry else []


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
            exe = omp_exe(pid)
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


def diff_text(details, limit=8000):
    """The edit's diff from its tool result; a multi-file edit gets one headed block per file."""
    if not isinstance(details, dict):
        return ''
    files = details.get('perFileResults')
    if isinstance(files, list) and files:
        text = '\n\n'.join(f"{f.get('path', '')}\n{f.get('diff', '')}" for f in files if isinstance(f, dict) and f.get('diff'))
    else:
        text = details.get('diff') or ''
        if text and details.get('path'):
            text = f"{details['path']}\n{text}"
    return text if len(text) <= limit else text[:limit] + '\n… (truncated)'


def session_title(path):
    """omp's own name for the session (first record of the file), without a leading emoji or "OMP:" tag."""
    try:
        with open(path, 'rb') as f:
            record = json.loads(f.readline())
    except (OSError, ValueError):
        return None
    title = record.get('title') if record.get('type') == 'title' else None
    if not isinstance(title, str):
        return None
    title = re.sub(r'^[^\w]+', '', title).strip()
    title = re.sub(r'^OMP:\s*', '', title, flags=re.I)
    return title or None


def session_data(path, cwd, pid):
    phases, calls, workers, model, effort = [], {}, {}, None, None
    tokens = None
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
                    action['id'] = ident
                    action['input'] = args_text(name, args)
                    if name == 'task' and isinstance(args, dict):
                        action['names'] = [t.get('name') for t in args.get('tasks', []) if isinstance(t, dict) and t.get('name')]
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
                    action['output'] = result_text(msg)
                    if msg.get('toolName') == 'edit':
                        action['diff'] = diff_text(msg.get('details'))
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
    # Subagent progress comes from each worker's own transcript; only running workers
    # and the ones this turn's task calls named are read.
    wanted = {w['id'] for w in workers.values() if w.get('status') in ('started', 'running')}
    for action in ordered:
        wanted.update(action.get('names', []))
    for ident in wanted:
        if ident in workers and re.fullmatch(r'[A-Za-z0-9_-]+', ident):
            transcript = os.path.join(session_dir, ident + '.jsonl')
            if os.path.isfile(transcript):
                workers[ident].update(worker_activity(transcript))
    for action in ordered:
        if 'names' in action:
            action['workers'] = [workers[n] for n in action.pop('names') if n in workers]
    for action in ordered[:-BODY_ACTIONS]:
        action.pop('input', None)
        action.pop('output', None)
        action.pop('diff', None)
    return {
        'phases': phases,
        'turn': {'started': turn['started'], 'tools': len(ordered), 'counts': counts},
        'actions': ordered[-MAX_ACTIONS:][::-1],
        'workers': list(workers.values())[::-1],
        'model': model,
        'effort': effort,
        'tokens': tokens,
        'window': context_window(pid, (model or '').split(':')[0]) if model else None,
        'limits': usage_limits(pid, model.split('/')[0]) if model and '/' in model else [],
        'branch': git_branch(cwd),
        'title': session_title(path),
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
