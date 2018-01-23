'use strict';
// p0f v3 client - http://lcamtuf.coredump.cx/p0f3/

const net    = require('net');
const ipaddr = require('ipaddr.js');

function P0FClient (path) {
    const self = this;

    this.sock = null;
    this.send_queue = [];
    this.receive_queue = [];
    this.connected = false;
    this.ready = false;
    this.socket_has_error = false;
    this.restart_interval = false;

    function connect () {
        self.sock = net.createConnection(path);
        self.sock.setTimeout(5 * 1000);

        self.sock.on('connect', function () {
            self.sock.setTimeout(30 * 1000);
            self.connected = true;
            self.socket_has_error = false;
            self.ready = true;
            if (self.restart_interval) clearInterval(self.restart_interval);
            self.process_send_queue();
        });

        self.sock.on('data', function (data) {
            for (let i=0; i<data.length/232; i++) {
                self.decode_response(data.slice(((i) ? 232*i : 0), 232*(i+1)));
            }
        });

        self.sock.on('drain', function () {
            self.ready = true;
            self.process_send_queue();
        });

        self.sock.on('error', function (error) {
            self.connected = false;
            error.message = `${error.message} (socket: ${path})`;
            self.socket_has_error = error;
            self.sock.destroy();
            // Try and reconnect
            if (!self.restart_interval) {
                self.restart_interval = setInterval(function () {
                    connect();
                }, 5 * 1000);
            }
            // Clear the receive queue
            for (let i=0; i<self.receive_queue.length; i++) {
                const item = self.receive_queue.shift();
                item.cb(self.socket_has_error);
                continue;
            }
            self.process_send_queue();
        });
    }
    connect();
}

P0FClient.prototype.shutdown = function () {
    if (this.restart_interval) {
        clearInterval(this.restart_interval);
    }
}

P0FClient.prototype.decode_response = function (data) {

    function decode_string (data2, start, end) {
        let str = '';
        for (let a=start; a<end; a++) {
            const b = data2.readUInt8(a);
            if (b === 0x0) break;
            str = str + String.fromCharCode(b);
        }
        return str;
    }

    if (this.receive_queue.length <= 0) {
        throw new Error('unexpected data received');
    }
    const item = this.receive_queue.shift();

    ///////////////////
    // Decode packet //
    ///////////////////

    // Response magic dword (0x50304602), native endian.
    if (data.readUInt32LE(0) !== 0x50304602) {
        return item.cb(new Error('bad response magic!'));
    }

    // Status dword: 0x00 for 'bad query', 0x10 for 'OK', and 0x20 for 'no match'
    const st = data.readUInt32LE(4);
    switch (st) {
        case (0x00):
            return item.cb(new Error('bad query'));
        case (0x10): {
            const p0f = {
                query:       item.ip,
                first_seen:  data.readUInt32LE(8),
                last_seen:   data.readUInt32LE(12),
                total_conn:  data.readUInt32LE(16),
                uptime_min:  data.readUInt32LE(20),
                up_mod_days: data.readUInt32LE(24),
                last_nat:    data.readUInt32LE(28),
                last_chg:    data.readUInt32LE(32),
                distance:    data.readInt16LE(36),
                bad_sw:      data.readUInt8(38),
                os_match_q:  data.readUInt8(39),
                os_name:     decode_string(data, 40, 72),
                os_flavor:   decode_string(data, 72, 104),
                http_name:   decode_string(data, 104, 136),
                http_flavor: decode_string(data, 136, 168),
                link_type:   decode_string(data, 168, 200),
                language:    decode_string(data, 200, 232),
            }
            return item.cb(null, p0f);
        }
        case (0x20):
            return item.cb(null, null);
        default:
            throw new Error(`unknown status: ${st}`);
    }
};

P0FClient.prototype.query = function (ip, cb) {
    if (this.socket_has_error) {
        return cb(this.socket_has_error);
    }
    if (!this.connected) {
        return cb(new Error('socket not connected'));
    }
    const addr = ipaddr.parse(ip);
    const bytes = addr.toByteArray();
    const buf = new Buffer(21);
    buf.writeUInt32LE(0x50304601, 0); // query magic
    buf.writeUInt8(((addr.kind() === 'ipv6') ? 0x6 : 0x4), 4);
    for (let i=0; i < bytes.length; i++) {
        buf.writeUInt8(bytes[i], 5 + i);
    }
    if (!this.ready) {
        this.send_queue.push({ip: ip, cb: cb, buf: buf});
    }
    else {
        this.receive_queue.push({ip: ip, cb: cb});
        if (!this.sock.write(buf)) this.ready = false;
    }
};

P0FClient.prototype.process_send_queue = function () {
    if (this.send_queue.length === 0) { return; }

    for (let i=0; i<this.send_queue.length; i++) {
        let item;
        if (this.socket_has_error) {
            item = this.send_queue.shift();
            item.cb(this.socket_has_error);
            continue;
        }
        if (!this.ready) break;
        item = this.send_queue.shift();
        this.receive_queue.push({ip: item.ip, cb: item.cb});
        if (!this.sock.write(item.buf)) {
            this.ready = false;
        }
    }
};

function start_p0f_client (sp, server, next) {
    if (!sp) {
        server.logerror("main.socket_path not defined in p0f.ini!");
        return next();
    }
    // Start p0f process
    server.notes.p0f_client = new P0FClient(sp);
    next();
}

exports.P0FClient = P0FClient;

exports.register = function () {
    this.load_p0f_ini();
};

exports.load_p0f_ini = function () {
    const plugin = this;
    plugin.cfg = plugin.config.get('p0f.ini', function () {
        plugin.load_p0f_ini();
    });
}

exports.hook_init_master = function (next, server) {
    start_p0f_client(this.cfg.main.socket_path, server, next);
}

exports.hook_init_child = function (next, server) {
    start_p0f_client(this.cfg.main.socket_path, server, next);
};

exports.hook_lookup_rdns = function onLookup (next, connection) {
    const plugin = this;
    if (connection.remote.is_private) return next();

    if (!connection.server.notes.p0f_client) {
        connection.logerror(plugin, 'missing server');
        return next();
    }

    connection.server.notes.p0f_client.query(connection.remote.ip, (err, result) => {
        if (err) {
            connection.results.add(plugin, {err: err.message});
            return next();
        }

        if (!result) {
            connection.results.add(plugin, {err: 'no p0f results'});
            return next();
        }

        connection.loginfo(plugin, format_results(result));
        connection.results.add(plugin, result);
        next();
    });
};

function format_results (r) {
    const data = [];
    if (r.os_name) data.push(`os="${r.os_name} ${r.os_flavor}"`);
    if (r.link_type) data.push(`link_type="${r.link_type}"`);
    if (r.distance) data.push(`distance=${r.distance}`);
    if (r.total_conn) data.push(`total_conn=${r.total_conn}`);
    if (r.last_nat) data.push(`shared_ip=${((r.last_nat === 0) ? 'N' : 'Y')}`);
    return data.join(' ');
}

exports.hook_data_post = function (next, connection) {
    const plugin = this;
    if (connection.remote.is_private) return next();

    const header_name = plugin.cfg.main.add_header;
    if (!header_name) {
        connection.logdebug(plugin, 'header disabled in ini' );
        return next();
    }

    connection.transaction.remove_header(header_name);
    const result = connection.results.get('p0f');
    if (!result || !result.os_name) {
        connection.results.add(plugin, {err: 'no p0f note'});
        return next();
    }

    connection.logdebug(plugin, 'adding header');
    connection.transaction.add_header(header_name, format_results(result));

    next();
}
