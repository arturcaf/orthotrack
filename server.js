const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
// No Railway, ao anexar um volume, RAILWAY_VOLUME_MOUNT_PATH é definido automaticamente.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'pacientes.json');
const RX_DIR = path.join(DATA_DIR, 'rx');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MAX_BODY = 25 * 1024 * 1024;

const FRATURAS = ['radio_distal', 'clavicula', 'umero_proximal', 'umero_diafise', 'femur_diafise', 'tibia_diafise', 'tornozelo'];
const TRATAMENTOS = ['conservador', 'cirurgico'];
const MECANISMOS = ['Queda da própria altura', 'Acidente de trânsito', 'Trauma esportivo', 'Queda de altura'];

const PACIENTE_EXEMPLO = {
    id: 'exemplo-otavio',
    nome: 'Otávio Fulano de tal',
    dataNascimento: '1991-01-01',
    dataTrauma: '2026-09-19',
    mecanismo: 'Acidente de trânsito',
    fratura: 'umero_diafise',
    tratamento: 'cirurgico',
    dataIntervencao: '2026-09-19',
    criadoEm: '2026-09-20T00:00:00.000Z',
    atualizadoEm: '2026-09-20T00:00:00.000Z',
    avaliacoes: [
        { id: 'exemplo-otavio-av1', dataAtendimento: '2026-09-20', notas: '', rx: null, criadoEm: '2026-09-20T00:00:00.000Z' }
    ]
};

class ErroHttp extends Error {
    constructor(status, mensagem) {
        super(mensagem);
        this.status = status;
    }
}

let db;
let filaEscrita = Promise.resolve();

async function carregarDb() {
    await fsp.mkdir(RX_DIR, { recursive: true });
    try {
        db = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        db = { pacientes: [PACIENTE_EXEMPLO] };
        await salvarDb();
    }
}

// Escritas em fila e atômicas (arquivo temporário + rename) para não corromper o JSON.
function salvarDb() {
    const conteudo = JSON.stringify(db, null, 2);
    filaEscrita = filaEscrita.catch(() => {}).then(async () => {
        const tmp = DB_FILE + '.tmp';
        await fsp.writeFile(tmp, conteudo);
        await fsp.rename(tmp, DB_FILE);
    });
    return filaEscrita;
}

function dataValida(valor) {
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
    const [a, m, d] = valor.split('-').map(Number);
    const data = new Date(Date.UTC(a, m - 1, d));
    return data.getUTCFullYear() === a && data.getUTCMonth() === m - 1 && data.getUTCDate() === d;
}

function formatarData(iso) {
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
}

// Mesma regra do front-end: cirurgia conta a partir da data da cirurgia; conservador, do trauma.
function dataReferencia(p) {
    return p.tratamento === 'cirurgico' && p.dataIntervencao ? p.dataIntervencao : p.dataTrauma;
}

function validarPaciente(corpo, avaliacoesExistentes = []) {
    const p = {
        nome: String(corpo.nome || '').trim().slice(0, 120),
        dataNascimento: corpo.dataNascimento || '',
        dataTrauma: corpo.dataTrauma || '',
        mecanismo: corpo.mecanismo,
        fratura: corpo.fratura,
        tratamento: corpo.tratamento,
        dataIntervencao: corpo.dataIntervencao || ''
    };
    if (!p.nome) throw new ErroHttp(400, 'Informe o nome do paciente.');
    if (!p.dataTrauma) throw new ErroHttp(400, 'Informe a data do trauma.');
    for (const [campo, rotulo] of [['dataNascimento', 'nascimento'], ['dataTrauma', 'trauma'], ['dataIntervencao', 'intervenção']]) {
        if (p[campo] && !dataValida(p[campo])) throw new ErroHttp(400, `Data de ${rotulo} inválida.`);
    }
    if (!MECANISMOS.includes(p.mecanismo)) throw new ErroHttp(400, 'Mecanismo de trauma inválido.');
    if (!FRATURAS.includes(p.fratura)) throw new ErroHttp(400, 'Fratura inválida.');
    if (!TRATAMENTOS.includes(p.tratamento)) throw new ErroHttp(400, 'Selecione o tratamento.');
    if (p.dataNascimento && p.dataNascimento > p.dataTrauma) {
        throw new ErroHttp(400, 'A data de nascimento não pode ser posterior à data do trauma.');
    }
    if (p.dataIntervencao && p.dataIntervencao < p.dataTrauma) {
        throw new ErroHttp(400, 'A data da cirurgia/imobilização não pode ser anterior à data do trauma.');
    }
    const ref = dataReferencia(p);
    const anterior = avaliacoesExistentes.find(a => a.dataAtendimento < ref);
    if (anterior) {
        throw new ErroHttp(400, `Já existe uma avaliação em ${formatarData(anterior.dataAtendimento)}, anterior à nova data de referência (${formatarData(ref)}).`);
    }
    return p;
}

function acharPaciente(id) {
    const paciente = db.pacientes.find(p => p.id === id);
    if (!paciente) throw new ErroHttp(404, 'Paciente não encontrado.');
    return paciente;
}

async function removerRx(nome) {
    if (!nome) return;
    await fsp.unlink(path.join(RX_DIR, nome)).catch(err => {
        if (err.code !== 'ENOENT') console.error('Falha ao remover RX', nome, err);
    });
}

function enviarJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

function lerCorpo(req) {
    return new Promise((resolve, reject) => {
        const partes = [];
        let tamanho = 0;
        req.on('data', parte => {
            tamanho += parte.length;
            if (tamanho <= MAX_BODY) partes.push(parte);
        });
        req.on('end', () => {
            if (tamanho > MAX_BODY) return reject(new ErroHttp(413, 'Arquivo muito grande.'));
            try {
                resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}'));
            } catch {
                reject(new ErroHttp(400, 'Requisição inválida.'));
            }
        });
        req.on('error', reject);
    });
}

function autorizado(req) {
    if (!APP_PASSWORD) return true;
    const [tipo, credencial] = (req.headers.authorization || '').split(' ');
    if (tipo !== 'Basic' || !credencial) return false;
    const senha = Buffer.from(credencial, 'base64').toString('utf8').split(':').slice(1).join(':');
    const a = crypto.createHash('sha256').update(senha).digest();
    const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
}

async function servirIndex(res) {
    const html = await fsp.readFile(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
}

const TIPOS_RX = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function servirRx(res, nome) {
    const m = /^[a-z0-9-]+\.(jpg|png|webp)$/.exec(nome);
    if (!m) throw new ErroHttp(404, 'Imagem não encontrada.');
    let dados;
    try {
        dados = await fsp.readFile(path.join(RX_DIR, nome));
    } catch (err) {
        if (err.code === 'ENOENT') throw new ErroHttp(404, 'Imagem não encontrada.');
        throw err;
    }
    res.writeHead(200, { 'Content-Type': TIPOS_RX[m[1]], 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(dados);
}

async function rotear(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const partes = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const metodo = req.method;

    if (partes[0] === 'rx' && partes.length === 2 && metodo === 'GET') return servirRx(res, partes[1]);
    if (partes[0] !== 'api') {
        if (metodo === 'GET') return servirIndex(res);
        throw new ErroHttp(404, 'Não encontrado.');
    }
    if (partes[1] !== 'pacientes' || partes.length > 5) throw new ErroHttp(404, 'Não encontrado.');

    const [, , pacienteId, sub, avaliacaoId] = partes;
    const agora = new Date().toISOString();

    // /api/pacientes
    if (!pacienteId) {
        if (metodo === 'GET') return enviarJson(res, 200, db.pacientes);
        if (metodo === 'POST') {
            const dados = validarPaciente(await lerCorpo(req));
            const novo = { id: crypto.randomUUID(), ...dados, criadoEm: agora, atualizadoEm: agora, avaliacoes: [] };
            db.pacientes.push(novo);
            await salvarDb();
            return enviarJson(res, 201, novo);
        }
        throw new ErroHttp(405, 'Método não permitido.');
    }

    // /api/pacientes/:id
    if (!sub) {
        const paciente = acharPaciente(pacienteId);
        if (metodo === 'GET') return enviarJson(res, 200, paciente);
        if (metodo === 'PUT') {
            const dados = validarPaciente(await lerCorpo(req), paciente.avaliacoes);
            const atual = acharPaciente(pacienteId);
            Object.assign(atual, dados, { atualizadoEm: agora });
            await salvarDb();
            return enviarJson(res, 200, atual);
        }
        if (metodo === 'DELETE') {
            db.pacientes = db.pacientes.filter(p => p.id !== pacienteId);
            await salvarDb();
            await Promise.all(paciente.avaliacoes.map(a => removerRx(a.rx)));
            res.writeHead(204);
            return res.end();
        }
        throw new ErroHttp(405, 'Método não permitido.');
    }

    if (sub !== 'avaliacoes') throw new ErroHttp(404, 'Não encontrado.');

    // /api/pacientes/:id/avaliacoes
    if (!avaliacaoId) {
        if (metodo !== 'POST') throw new ErroHttp(405, 'Método não permitido.');
        const corpo = await lerCorpo(req);
        const paciente = acharPaciente(pacienteId);
        const dataAtendimento = corpo.dataAtendimento;
        if (!dataValida(dataAtendimento)) throw new ErroHttp(400, 'Informe uma data de avaliação válida.');
        const ref = dataReferencia(paciente);
        if (dataAtendimento < ref) {
            throw new ErroHttp(400, `A data da avaliação (${formatarData(dataAtendimento)}) é anterior à data de referência (${formatarData(ref)}).`);
        }

        const id = crypto.randomUUID();
        let rx = null;
        if (corpo.rx) {
            const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(corpo.rx);
            if (!m) throw new ErroHttp(400, 'Formato de imagem não suportado (use JPEG, PNG ou WebP).');
            rx = `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
            await fsp.writeFile(path.join(RX_DIR, rx), Buffer.from(m[2], 'base64'));
        }

        const avaliacao = { id, dataAtendimento, notas: String(corpo.notas || '').trim().slice(0, 5000), rx, criadoEm: agora };
        let atual;
        try {
            atual = acharPaciente(pacienteId); // pode ter sido excluído durante o upload
        } catch (err) {
            await removerRx(rx);
            throw err;
        }
        atual.avaliacoes.push(avaliacao);
        atual.avaliacoes.sort((a, b) => a.dataAtendimento.localeCompare(b.dataAtendimento) || a.criadoEm.localeCompare(b.criadoEm));
        atual.atualizadoEm = agora;
        await salvarDb();
        return enviarJson(res, 201, { paciente: atual, avaliacao });
    }

    // /api/pacientes/:id/avaliacoes/:avaliacaoId
    if (metodo !== 'DELETE') throw new ErroHttp(405, 'Método não permitido.');
    const paciente = acharPaciente(pacienteId);
    const avaliacao = paciente.avaliacoes.find(a => a.id === avaliacaoId);
    if (!avaliacao) throw new ErroHttp(404, 'Avaliação não encontrada.');
    paciente.avaliacoes = paciente.avaliacoes.filter(a => a.id !== avaliacaoId);
    paciente.atualizadoEm = agora;
    await salvarDb();
    await removerRx(avaliacao.rx);
    return enviarJson(res, 200, paciente);
}

const server = http.createServer((req, res) => {
    if (!autorizado(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OrthoTrack", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Autenticação necessária.');
        return;
    }
    rotear(req, res).catch(err => {
        const status = err instanceof ErroHttp ? err.status : 500;
        if (status === 500) console.error(err);
        if (!res.headersSent) enviarJson(res, status, { erro: status === 500 ? 'Erro interno do servidor.' : err.message });
    });
});

carregarDb()
    .then(() => {
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`OrthoTrack rodando na porta ${PORT} (dados em ${DATA_DIR})`);
        });
    })
    .catch(err => {
        console.error('Falha ao carregar os dados:', err);
        process.exit(1);
    });
