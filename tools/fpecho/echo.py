#!/usr/bin/env python3
"""Local TLS/HTTP2 fingerprint echo (no proxy in between).

Usage: python3 tools/fpecho/echo.py [port]   then open https://localhost:PORT/ with the
client under test (Sharko: SHARKO... --ignore cert via extra root, Chromium:
--ignore-certificate-errors). Prints JA3 (+hash), JA4 and the Akamai h2 fingerprint of
every connection as one JSON line. The ClientHello is peeked before the TLS handshake.
"""
import hashlib, json, socket, ssl, struct, subprocess, sys, tempfile, os, threading

GREASE = {(i << 8) | 0x0A | (i << 12) & 0xF000 for i in range(16)}
GREASE = {0x0A0A + 0x1010 * i for i in range(16)}

def parse_hello(b):
    # TLS record -> handshake -> ClientHello
    p = 5 + 4
    ver = struct.unpack('>H', b[p:p+2])[0]; p += 34
    p += 1 + b[p]
    cl = struct.unpack('>H', b[p:p+2])[0]; p += 2
    ciphers = [struct.unpack('>H', b[p+i:p+i+2])[0] for i in range(0, cl, 2)]; p += cl
    p += 1 + b[p]
    el = struct.unpack('>H', b[p:p+2])[0]; p += 2
    end = p + el
    exts = []; data = {}
    while p < end:
        t, l = struct.unpack('>HH', b[p:p+4]); exts.append(t); data[t] = b[p+4:p+4+l]; p += 4 + l
    return ver, ciphers, exts, data

def u16list(d, off=2):
    return [struct.unpack('>H', d[i:i+2])[0] for i in range(off, len(d), 2)]

def fingerprints(b):
    ver, ciphers, exts, d = parse_hello(b)
    ng = lambda l: [x for x in l if x not in GREASE]
    groups = ng(u16list(d.get(10, b'\0\0')))
    pf = list(d.get(11, b'\0')[1:])
    ja3s = f"{ver},{'-'.join(map(str, ng(ciphers)))},{'-'.join(map(str, ng(exts)))},{'-'.join(map(str, groups))},{'-'.join(map(str, pf))}"
    sigs = u16list(d.get(13, b'\0\0'))
    alpn = d.get(16, b'')
    first = alpn[3:3+alpn[2]].decode() if len(alpn) > 3 else ''
    a = {'h2': 'h2', 'http/1.1': 'h1'}.get(first, '00')
    tv = '13'
    sv = d.get(43)
    if sv:
        vs = [x for x in u16list(sv, 1) if x not in GREASE]
        tv = {0x0304: '13', 0x0303: '12'}.get(max(vs), '00')
    sni = 'd' if 0 in exts else 'i'
    ex = ng(exts)
    c = ng(ciphers)
    h = lambda s: hashlib.sha256(s.encode()).hexdigest()[:12]
    cs = ','.join(f'{x:04x}' for x in sorted(c))
    es = ','.join(f'{x:04x}' for x in sorted(x for x in ex if x not in (0, 16)))
    ss = ','.join(f'{x:04x}' for x in sigs)
    ja4 = f"t{tv}{sni}{len(c):02d}{len(ex):02d}{a}_{h(cs)}_{h(es + '_' + ss)}"
    return {'ja3': ja3s, 'ja3_hash': hashlib.md5(ja3s.encode()).hexdigest(), 'ja4': ja4,
            'ext_order': [f'{x}{"(G)" if x in GREASE else ""}' for x in exts],
            'ciphers': [f'{x:04x}' for x in ciphers], 'groups': [f'{x:04x}' for x in u16list(d.get(10, b"\0\0"))],
            'sigalgs': [f'{x:04x}' for x in sigs], 'alps': 17513 in exts or 17613 in exts,
            'cert_compression': (u16list(d[27], 1) if 27 in d else None), 'first_alpn': first}

def recvn(s, n):
    buf = b''
    while len(buf) < n:
        c = s.recv(n - len(buf))
        if not c: raise EOFError
        buf += c
    return buf

def h2_fp(s):
    if recvn(s, 24) != b'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n': return None
    settings = []; wu = 0; prio = []; order = ''
    while True:
        h = recvn(s, 9); ln = int.from_bytes(h[:3], 'big'); ty = h[3]; fl = h[4]; sid = struct.unpack('>I', h[5:])[0] & 0x7fffffff
        body = recvn(s, ln)
        if ty == 4 and not fl & 1:
            for i in range(0, ln, 6): settings.append(f'{struct.unpack(">H", body[i:i+2])[0]}:{struct.unpack(">I", body[i+2:i+6])[0]}')
        elif ty == 8 and sid == 0: wu = struct.unpack('>I', body)[0]
        elif ty == 2: prio.append(f'{sid}:{body[4]+1}:{body[0]>>7}:{struct.unpack(">I", body[:4])[0]&0x7fffffff}')
        elif ty == 1:
            try:
                import hpack
                blk = body
                if fl & 8: blk = blk[1:len(blk) - blk[0]]
                if fl & 0x20: blk = blk[5:]
                hdrs = [f'{k}: {v}' if not isinstance(k, bytes) else f'{k.decode()}: {v.decode()}' for k, v in hpack.Decoder().decode(blk)]
            except Exception as e:
                hdrs = [repr(e)]
            return {'headers': hdrs, 'settings': ';'.join(settings), 'window_update': wu, 'priority_frames': ','.join(prio) or '0',
                    'hdr_flags_priority': bool(fl & 0x20), 'pseudo_order': hpack_pseudo(body, fl)}

def hpack_pseudo(b, fl):
    # minimal: pseudo headers are indexed from the static table (2,3=:method 4,5=:path 6,7=:scheme 1=:authority 8-14=:status)
    p = 0
    if fl & 8: p += 1 + b[0]
    if fl & 0x20: p += 5
    names = {1: 'a', 2: 'm', 3: 'm', 4: 'p', 5: 'p', 6: 's', 7: 's'}
    out = ''
    while p < len(b):
        x = b[p]
        if x & 0x80:
            i = x & 0x7f; out += names.get(i, '?')
            if i > 7 or i == 0: break
            p += 1
        elif x & 0xC0 == 0x40:
            i = x & 0x3f; 
            if i in (1, 4): out += names[i]
            else: break
            p += 1
            # skip value (huffman or raw) length
            l = b[p] & 0x7f; p += 1 + l
        else: break
    return ','.join(out)

def serve(conn, ctx):
    try:
        conn.settimeout(10)
        hello = conn.recv(65536, socket.MSG_PEEK)
        info = fingerprints(hello)
        tls = ctx.wrap_socket(conn, server_side=True)
        info['alpn'] = tls.selected_alpn_protocol()
        if info['alpn'] == 'h2':
            info['h2'] = h2_fp(tls)
            h2_akamai = info['h2'] and f"{info['h2']['settings']}|{info['h2']['window_update']}|{info['h2']['priority_frames']}|{info['h2']['pseudo_order']}"
            info['akamai_h2'] = h2_akamai
        else:
            tls.recv(4096); tls.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
        print(json.dumps(info), flush=True)
    except Exception as e:
        print(json.dumps({'error': repr(e)}), flush=True)
    finally:
        conn.close()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
    d = os.path.dirname(os.path.abspath(__file__))
    crt, key = os.path.join(d, 'cert.pem'), os.path.join(d, 'key.pem')
    if not os.path.exists(crt):
        subprocess.check_call(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '3650',
                               '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], stderr=subprocess.DEVNULL)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(crt, key); ctx.set_alpn_protocols(['h2', 'http/1.1'])
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(('127.0.0.1', port)); srv.listen(16)
    print(f'echo on https://localhost:{port}/', file=sys.stderr, flush=True)
    while True:
        c, _ = srv.accept(); threading.Thread(target=serve, args=(c, ctx), daemon=True).start()
