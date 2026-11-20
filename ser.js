// ═════════════════════════════════════════════════════════════════
// server.js — Polo Game Server v9.1-PRODUCTION (Render Free Optimized)
// ✅ Sleep-friendly (no self-ping)
// ✅ SAFE_MODE support
// ✅ Circuit breaker
// ✅ Atomic claim_round
// ✅ Direct withdrawal approval + instant admin error alert
// ✅ loadAppConfig / saveAppConfig / deepMerge included & persisted
// ═════════════════════════════════════════════════════════════════

require('dotenv').config();

const SHOW_LOGS = true;
const _realConsole = {
    log: console.log.bind(console), info: console.info.bind(console),
    debug: console.debug.bind(console), trace: console.trace.bind(console),
    error: console.error.bind(console), warn: console.warn.bind(console),
};
process.env.SHOW_LOGS = SHOW_LOGS ? 'true' : 'false';
function logCritical(...args) { if (SHOW_LOGS) _realConsole.error(...args); }

// ═══ SAFE MODE ═══
const SAFE_MODE = process.env.SAFE_MODE === 'true';
if (SAFE_MODE) {
    logCritical('═══════════════════════════════════════════════════');
    logCritical('🛡️  SAFE MODE ENABLED — withdrawals BLOCKED');
    logCritical('═══════════════════════════════════════════════════');
}

// ═══ CIRCUIT BREAKER ═══
const CIRCUIT_BREAKER = { errors: [], threshold: 3, windowMs: 60000, tripped: false, trippedAt: null, reason: null };
function recordCriticalError(reason) {
    const now = Date.now();
    CIRCUIT_BREAKER.errors = CIRCUIT_BREAKER.errors.filter(t => now - t < CIRCUIT_BREAKER.windowMs);
    CIRCUIT_BREAKER.errors.push(now);
    logCritical(`🚨 [CIRCUIT] Critical error (${CIRCUIT_BREAKER.errors.length}/${CIRCUIT_BREAKER.threshold}): ${reason}`);
    if (CIRCUIT_BREAKER.errors.length >= CIRCUIT_BREAKER.threshold && !CIRCUIT_BREAKER.tripped) {
        CIRCUIT_BREAKER.tripped = true;
        CIRCUIT_BREAKER.trippedAt = new Date().toISOString();
        CIRCUIT_BREAKER.reason = reason;
        logCritical('═══════════════════════════════════════════════════');
        logCritical(`🛑 [CIRCUIT] TRIPPED at ${CIRCUIT_BREAKER.trippedAt} — reason: ${reason}`);
        logCritical('🛑 [CIRCUIT] All withdrawals BLOCKED. Manual reset required.');
        logCritical('═══════════════════════════════════════════════════');
        if (typeof io !== 'undefined' && io) {
            io.to('admin_room').emit('circuit_breaker_tripped', { reason, timestamp: CIRCUIT_BREAKER.trippedAt });
            io.emit('game_stopped', { reason: 'CIRCUIT_BREAKER', message: '🛑 اللعبة متوقفة مؤقتاً لأسباب أمنية' });
        }
    }
}
function isCircuitTripped() { return CIRCUIT_BREAKER.tripped; }
function resetCircuit() { CIRCUIT_BREAKER.tripped = false; CIRCUIT_BREAKER.errors = []; CIRCUIT_BREAKER.trippedAt = null; CIRCUIT_BREAKER.reason = null; logCritical('✅ [CIRCUIT] Manually reset'); }

function emitAdminWithdrawalError(payload) {
    if (typeof io !== 'undefined' && io) {
        io.to('admin_room').emit('admin_withdrawal_error', {
            ...payload,
            timestamp: payload.timestamp || new Date().toISOString(),
        });
    }
}

let speakeasy, QRCode;
try { speakeasy = require('speakeasy'); QRCode = require('qrcode'); } catch (e) { logCritical('⚠️ 2FA libs missing'); }

const path = require('path');
const { ethers } = require('ethers');
const crypto = require('crypto');

process.on('uncaughtException', (err) => { logCritical('💥 uncaughtException:', err.stack || err.message); recordCriticalError('uncaughtException: ' + err.message); });
process.on('unhandledRejection', (reason) => { logCritical('💥 unhandledRejection:', reason && reason.stack ? reason.stack : reason); recordCriticalError('unhandledRejection'); });

// ═══ ENV Validation ═══
const REQUIRED_ENV = ['APP_SECRET', 'JWT_SECRET', 'ADMIN_JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ADMIN_TOKEN', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'MNEMONIC', 'ADMIN_2FA_SECRET', 'POLYGON_RPC_URL', 'OWNER_WALLET', 'SAFE_MODE'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) { logCritical(`❌ Missing env: ${missing.join(', ')}`); process.exit(1); }
if (process.env.JWT_SECRET === process.env.APP_SECRET) { logCritical('❌ JWT_SECRET must differ from APP_SECRET'); process.exit(1); }
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) { logCritical('❌ JWT_SECRET must be >= 32 chars'); process.exit(1); }
if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$/.test(process.env.ADMIN_PASSWORD || '')) { logCritical('❌ ADMIN_PASSWORD too weak'); process.exit(1); }
if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 24) { logCritical('❌ ADMIN_TOKEN too short'); process.exit(1); }
if (!/^0x[a-fA-F0-9]{40}$/.test(process.env.OWNER_WALLET || '')) { logCritical('❌ OWNER_WALLET invalid'); process.exit(1); }

const WebSocket = require('ws');
global.WebSocket = WebSocket;
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const cors = require('cors');

const { timingSafeEqualStr } = require('./utils/crypto');
const supabaseService = require('./services/supabase');
const paymentService = require('./services/payment');
const supportService = require('./services/support');
const provablyFair = require('./services/provablyFair');
const { verifyIntegrityHeaders, verifyAppIntegrity } = require('./middleware/integrity');
const { verifyAdmin, generateAdminToken, verifyAdminToken } = require('./middleware/adminAuth');
const { generalLimiter, authLimiter, adminLimiter } = require('./middleware/rateLimit');
const { socketRateLimiter, behaviorTracker } = require('./middleware/socketBotProtection');
const { validate } = require('./middleware/validation');
const { userLock } = require('./middleware/mutex');

console.error('═══════════════════════════════════════════════════');
console.error('🏆 POLO GAME SERVER v9.1-PRODUCTION (Render Free Optimized)');
console.error('═══════════════════════════════════════════════════');

try { supabaseService.init(); } catch (e) { logCritical('❌ Supabase:', e.stack || e.message); process.exit(1); }
const supabase = supabaseService.get();

const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL, undefined, { staticNetwork: true });
provider.on('error', (e) => logCritical('⚠️ Provider:', e.message));

let adminWallet;
try { adminWallet = ethers.Wallet.fromPhrase((process.env.MNEMONIC || '').trim(), provider); }
catch (err) { logCritical('❌ MNEMONIC:', err.message); process.exit(1); }

if (adminWallet.address.toLowerCase() !== process.env.OWNER_WALLET.toLowerCase()) {
    logCritical(`❌ OWNER_WALLET (${process.env.OWNER_WALLET}) does not match derived wallet (${adminWallet.address})`);
    process.exit(1);
}

const USDT_CONTRACT_ADDRESS = process.env.USDT_CONTRACT_ADDRESS || '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const USDT_ABI = ["function transfer(address to, uint256 value) returns (bool)", "function balanceOf(address owner) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"];
const usdtContract = new ethers.Contract(USDT_CONTRACT_ADDRESS, USDT_ABI, adminWallet);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "https:"], connectSrc: ["'self'", "wss:", "https:", ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)] } }, crossOriginEmbedderPolicy: false }));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (origin, cb) => { if (!origin) return cb(null, true); if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes('*')) return cb(null, true); if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true); if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return cb(null, true); cb(new Error('CORS_BLOCKED')); }, credentials: true, methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'], allowedHeaders: ['Content-Type','Authorization','x-app-signature','x-app-package','x-app-timestamp','x-app-nonce','x-app-hmac','x-admin-token','x-user-id'] }));
app.options(/.*/, cors());

app.use(express.json({ limit: '10kb', verify: (req, res, buf) => { const ct = req.headers['content-type'] || ''; if (req.method === 'POST' && !ct.includes('application/json')) throw new Error('INVALID_CONTENT_TYPE'); if (parseInt(req.headers['content-length'] || '0', 10) > 10 * 1024) throw new Error('PAYLOAD_TOO_LARGE'); } }));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny', index: false }));
app.use((req, res, next) => { if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') return res.redirect(`https://${req.header('host')}${req.url}`); next(); });
app.use('/api/', generalLimiter);

const JWT_SIGN_SECRET = process.env.JWT_SECRET;

// ═══ Messages ═══
const MESSAGES = {
    AUTH: { MISSING_TOKEN: 'يرجى تسجيل الدخول للمتابعة', INVALID_TOKEN: 'انتهت صلاحية الجلسة', INVALID_TOKEN_TYPE: 'جلسة غير صالحة', USER_RESTRICTED: 'هذا الحساب غير متاح حالياً', AUTH_FAILED: 'تعذر تسجيل الدخول' },
    BET: { NOT_AUTHENTICATED: 'يرجى تسجيل الدخول أولاً', GAME_SUSPENDED: 'اللعبة غير متاحة مؤقتاً', INVALID_INPUT: 'يرجى التحقق من البيانات', INVALID_BET_ID: 'حدث خطأ في الرهان', DUPLICATE_BET_ID: 'تم استلام طلبك بالفعل', INVALID_BET_MIX: 'يمكنك اختيار نوع واحد فقط', INVALID_BET_TYPE_MIX: 'نوع الرهان غير متاح', INVALID_BET_TYPE: 'نوع الرهان غير صحيح', MAX_SLOTS_REACHED: 'يمكنك وضع رهان واحد فقط', SLOT_ALREADY_USED: 'لديك رهان نشط بالفعل', INVALID_AMOUNT: 'المبلغ غير صحيح', RATE_LIMITED: 'يرجى الانتظار لحظة', USER_NOT_FOUND: 'لم نتمكن من العثور على حسابك', ACCOUNT_UNDER_REVIEW: 'حسابك قيد المراجعة', INSUFFICIENT_DEMO: 'رصيد التجربة غير كافٍ', INSUFFICIENT_REAL: 'رصيدك غير كافٍ', DEDUCTION_FAILED: 'تعذر إتمام العملية', ALREADY_BET_THIS_ROUND: 'لديك رهان في هذه الجولة', DB_INSERT_FAILED: 'حدث خطأ مؤقت', BET_CREATION_FAILED: 'تعذر إنشاء الرهان', SERVER_ERROR: 'حدث خطأ مؤقت', CONCURRENT_REQUEST: 'يرجى الانتظار قليلاً', BET_PLACED: '✅ تم قبول رهانك' },
    WITHDRAWAL: { NOT_AUTHENTICATED: 'يرجى تسجيل الدخول', INVALID_ADDRESS_FORMAT: 'عنوان محفظة غير صحيح', INVALID_ADDRESS: 'عنوان المحفظة غير صالح', SELF_WITHDRAWAL: 'لا يمكن السحب لهذا العنوان', RATE_LIMITED: 'يرجى الانتظار لحظة', INVALID_AMOUNT: 'المبلغ غير صحيح', BELOW_MIN_WITHDRAWAL: 'الحد الأدنى للسحب هو 5$', ABOVE_MAX_WITHDRAWAL: 'الحد الأقصى للسحب هو 50$', USER_NOT_FOUND: 'تعذر العثور على الحساب', ACCOUNT_RESTRICTED: 'هذا الحساب غير متاح', ACCOUNT_UNDER_REVIEW: 'حسابك قيد المراجعة', INSUFFICIENT_BALANCE: 'رصيدك غير كافٍ', WITHDRAWAL_CREATION_FAILED: 'تعذر إنشاء طلب السحب', SERVER_ERROR: 'حدث خطأ مؤقت', WITHDRAWALS_PAUSED: 'السحب غير متاح مؤقتاً', WITHDRAWAL_SUCCESS: '✅ تم استلام طلب السحب', SAFE_MODE_BLOCKED: '🛡️ السحب معطل مؤقتاً (وضع الحماية)' },
    GAME: { BETTING_CLOSED: 'انتهى وقت الرهان', BETTING_OPEN: 'الرهان مفتوح', CASHOUT_SUCCESS: '✅ تم سحب أرباحك', CASHOUT_FAILED: 'تعذر إتمام السحب', GAME_STOPPED: 'اللعبة غير متاحة مؤقتاً', GAME_RESUMED: '✅ اللعبة متاحة', BET_CANCELLED: '✅ تم إلغاء رهانك', WELCOME_BACK: '✅ مرحباً بعودتك', BET_RECOVERED: 'تم استرداد أرباحك', CIRCUIT_BREAKER: '🛑 اللعبة متوقفة مؤقتاً' },
};

// ═══ Financial ═══
const DAILY_LOSS_ALERT = parseFloat(process.env.DAILY_LOSS_ALERT || '1000');
const HOURLY_LOSS_ALERT = parseFloat(process.env.HOURLY_LOSS_ALERT || '300');
const POL_THRESHOLDS = { CRITICAL: 0.10, DANGER: 0.50, WARNING: 1.00, SAFE: 2.00 };
let dailyLossTracker = { date: new Date().toISOString().slice(0, 10), totalLoss: 0, totalWin: 0, roundsCount: 0 };
let hourlyLossTracker = { hour: new Date().toISOString().slice(0, 13), totalLoss: 0, totalWin: 0 };
let globalEmergencyStop = false;
let currentPolState = { balance: 0, level: 'UNKNOWN', lastUpdate: null, withdrawalsPaused: false };

function trackLoss(amount) {
    const now = new Date(); const today = now.toISOString().slice(0, 10); const currentHour = now.toISOString().slice(0, 13);
    if (dailyLossTracker.date !== today) dailyLossTracker = { date: today, totalLoss: 0, totalWin: 0, roundsCount: 0 };
    if (hourlyLossTracker.hour !== currentHour) hourlyLossTracker = { hour: currentHour, totalLoss: 0, totalWin: 0 };
    if (amount > 0) { dailyLossTracker.totalLoss += amount; hourlyLossTracker.totalLoss += amount; } else { dailyLossTracker.totalWin += Math.abs(amount); hourlyLossTracker.totalWin += Math.abs(amount); }
    dailyLossTracker.roundsCount++;
    const netLoss = dailyLossTracker.totalLoss - dailyLossTracker.totalWin;
    if (netLoss >= DAILY_LOSS_ALERT && typeof io !== 'undefined' && io) io.to('admin_room').emit('daily_limit_alert', { reason: 'DAILY_LIMIT_ALERT', amount: netLoss, limit: DAILY_LOSS_ALERT, timestamp: new Date().toISOString() });
}
function canPlayMore() { if (isCircuitTripped()) return { allowed: false, reason: 'CIRCUIT_BREAKER' }; if (globalEmergencyStop) return { allowed: false, reason: 'ADMIN_STOPPED' }; return { allowed: true }; }
function canWithdraw() { if (SAFE_MODE) return { allowed: false, reason: 'SAFE_MODE' }; if (isCircuitTripped()) return { allowed: false, reason: 'CIRCUIT_BREAKER' }; return { allowed: true }; }

// ═══ Helpers ═══
async function safeSupabase(promiseBuilder, label = 'SUPABASE_OP') { try { const result = await promiseBuilder; if (result?.error) { logCritical(`❌ ${label}:`, result.error.message); return { data: null, error: result.error }; } return result; } catch (e) { logCritical(`❌ ${label} exception:`, e.message); return { data: null, error: e }; } }
async function waitWithTimeout(txPromise, timeoutMs = 120000) { const tx = await txPromise; return await Promise.race([tx.wait(), new Promise((_, rej) => setTimeout(() => rej(new Error('TX_TIMEOUT')), timeoutMs))]); }
async function getUser(userId) { if (!userId || !supabase) return null; const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).maybeSingle(); if (error) { logCritical(`❌ getUser(${userId}):`, error.message); return null; } return data; }
async function getOrCreateUser(userId) { const existing = await getUser(userId); if (existing) { if (!existing.deposit_address) { const a = paymentService.tryGetDepositAddress(userId); if (a) { const { data } = await supabase.from('users').update({ deposit_address: a }).eq('user_id', userId).select().single(); if (data) return data; } } return existing; } const depositAddress = paymentService.tryGetDepositAddress(userId); const newUser = { user_id: userId, username: `Player_${userId.slice(-4)}`, balance: 0, demo_balance: 10000, deposit_address: depositAddress, total_deposited: 0, total_withdrawn: 0, total_won: 0, total_wagered: 0 }; const { data, error } = await supabase.from('users').upsert(newUser, { onConflict: 'user_id', ignoreDuplicates: true }).select().maybeSingle(); if (error) { const { data: fb } = await supabase.from('users').select('*').eq('user_id', userId).maybeSingle(); if (fb) return fb; throw error; } if (!data) { const fresh = await getUser(userId); if (fresh) return fresh; throw new Error('USER_CREATION_RACE'); } return data; }
async function updateUserDemoBalance(userId, newDemoBalance) { const { data, error } = await supabase.from('users').update({ demo_balance: newDemoBalance, updated_at: new Date().toISOString() }).eq('user_id', userId).select().single(); if (error) return null; return data; }
async function atomicDeductBalance(userId, amount) { const { data, error } = await supabase.rpc('atomic_deduct_balance', { p_user_id: userId, p_amount: amount }); if (error) { logCritical('❌ atomic_deduct:', error.message); recordCriticalError('atomic_deduct: ' + error.message); return { success: false, reason: 'RPC_FAILED' }; } if (!data?.success) return { success: false, reason: data?.reason || 'UNKNOWN' }; return { success: true, newBalance: data.newBalance }; }
async function atomicCreditBalance(userId, amount) { const { data, error } = await supabase.rpc('atomic_credit_balance', { p_user_id: userId, p_amount: amount }); if (error) { logCritical('❌ atomic_credit:', error.message); recordCriticalError('atomic_credit: ' + error.message); return { success: false, reason: 'RPC_FAILED' }; } if (!data?.success) return { success: false, reason: data?.reason || 'UNKNOWN' }; return { success: true, newBalance: data.newBalance }; }
async function cashoutAtomic(userId, betId, winAmount, multiplier, crashPoint) { try { const { data, error } = await supabase.rpc('cashout_atomic', { p_user_id: userId, p_bet_id: betId, p_win_amount: winAmount, p_multiplier: multiplier, p_crash_point: crashPoint }); if (error) { logCritical('❌ cashout_atomic:', error.message); recordCriticalError('cashout_atomic: ' + error.message); return { success: false, reason: 'RPC_FAILED' }; } if (!data?.success) return { success: false, reason: data?.reason || 'UNKNOWN' }; return { success: true, newBalance: data.newBalance }; } catch (e) { logCritical('❌ cashoutAtomic:', e.message); return { success: false, reason: 'EXCEPTION' }; } }
async function logAdminAction(adminEmail, action, targetId, ip, metadata = {}) { try { await supabase.from('admin_audit_log').insert({ admin_email: adminEmail, action, target_id: targetId, ip, metadata: JSON.stringify(metadata), created_at: new Date().toISOString() }); } catch (e) {} }
async function logRefund(userId, amount, reason, metadata = {}) { try { await safeSupabase(supabase.from('refunds').insert({ user_id: userId, amount, reason, metadata: JSON.stringify(metadata), status: 'pending', created_at: new Date().toISOString() }), 'LOG_REFUND'); } catch (e) {} }

// ═══ Game Constants ═══
const COLOR_BETS = { red: { id: 'red', label: 'RED', color: '#FF4757', multiplier: 1.96 }, green: { id: 'green', label: 'GREEN', color: '#00E676', multiplier: 2.00 }, yellow: { id: 'yellow', label: 'YELLOW', color: '#FDD835', multiplier: 10.00 } };
const TRENBALL_BETS = JSON.parse(JSON.stringify(COLOR_BETS));
const WIN_CONDITIONS = { red: { type: 'lt', threshold: 2.00 }, green: { type: 'range', min: 2.00, max: 10.00 }, yellow: { type: 'gte', threshold: 10.00 } };
function evaluateColorWin(color, crashPoint) { const cp = Number(crashPoint); if (!Number.isFinite(cp) || cp < 1.0) return false; const cond = WIN_CONDITIONS[color]; if (!cond) return false; if (cond.type === 'lt') return cp < cond.threshold; if (cond.type === 'gte') return cp >= cond.threshold; if (cond.type === 'range') return cp >= cond.min && cp < cond.max; return false; }

const OWNER_POOL_SHARE = parseFloat(process.env.OWNER_POOL_SHARE || '0.10');
const MAX_SLOTS_PER_PLAYER = parseInt(process.env.MAX_SLOTS_PER_PLAYER || '3', 10);
const MIN_MS_BETWEEN_BETS = parseInt(process.env.MIN_MS_BETWEEN_BETS || '500', 10);
const MIN_MS_BETWEEN_CASHOUTS = parseInt(process.env.MIN_MS_BETWEEN_CASHOUTS || '100', 10);
let FRAUD_WIN_RATE_THRESHOLD = parseFloat(process.env.FRAUD_WIN_RATE_THRESHOLD || '0.90');
let FRAUD_MIN_BETS = parseInt(process.env.FRAUD_MIN_BETS || '100', 10);
let FRAUD_CHECK_HOURS = parseFloat(process.env.FRAUD_CHECK_HOURS || '24');
const DEVICE_FP_ENABLED = process.env.DEVICE_FP_ENABLED !== 'false';
const IP_CONSISTENCY_ENABLED = process.env.IP_CONSISTENCY_ENABLED !== 'false';
let WITHDRAWAL_FEE_FIXED = parseFloat(process.env.WITHDRAWAL_FEE_FIXED || '0.5');
function calculateWithdrawalFee(amount) { return WITHDRAWAL_FEE_FIXED; }
const MAX_BET_LIMIT = parseFloat(process.env.MAX_BET_LIMIT || '20');
const MAX_WITHDRAWAL_LIMIT = parseFloat(process.env.MAX_WITHDRAWAL_LIMIT || '50');

const DEFAULT_UI_CONFIG = {
    version: '9.1.0',
    gameSettings: {
        minBet: 0.01,
        maxBet: MAX_BET_LIMIT,
        minWithdrawal: 5.0,
        maxWithdrawal: MAX_WITHDRAWAL_LIMIT,
        withdrawalFee: 0.5,
        depositFee: 0.01,
        depositFeeFixed: 0.0,
        sweepFee: 0.0,
        demoBalance: 10000,
        demoEnabled: true,
        waitingDuration: 7000,
        growthRate: 0.06,
        autoCashOutDefault: 10.0,
        maxChartPoints: 500,
        maxHistory: 50,
        crashDuration: 3000,
        maxSlotsPerPlayer: MAX_SLOTS_PER_PLAYER,
        fraudCheckHours: FRAUD_CHECK_HOURS,
        showRedButton: true,
        showGreenButton: true,
        showCrashButton: true,
        showMoonButton: true
    },
    colorBets: COLOR_BETS,
    trenballBets: TRENBALL_BETS,
    winConditions: WIN_CONDITIONS,
    features: {
        enableDemoMode: true,
        enableTrenball: true,
        enableTransactions: true,
        enableRoundHistory: true,
        enablePlayersList: true,
        enableProfile: true,
        enableBotProtection: true,
        showBalance: true,
        enableWithdrawal: true,
        enableDeposit: true,
        enableSupport: true,
        enableAutoCashOut: true,
        showClassicTab: true,
        showTrenballTab: true,
        enableTrenballPayouts: true,
        pseudoRandomMode: true,
        pseudoRandomConfig: { enabled: true, intelligentMode: true, targetHouseEdge: parseFloat(process.env.HOUSE_EDGE || '0.10') }
    },
    urls: { serverUrl: process.env.ACTIVE_SERVER_URL || process.env.RENDER_EXTERNAL_URL || '' },
};

let UI_CONFIG = JSON.parse(JSON.stringify(DEFAULT_UI_CONFIG));
let MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL || '5');
let MAX_WITHDRAWAL = MAX_WITHDRAWAL_LIMIT;
let MAX_BET = MAX_BET_LIMIT;
let MIN_BET = parseFloat(process.env.MIN_BET || '0.01');
let MIN_DEPOSIT = parseFloat(process.env.MIN_DEPOSIT || '1.0');
let DEPOSIT_FEE = parseFloat(process.env.DEPOSIT_FEE || '0.01');
let DEPOSIT_FEE_FIXED = parseFloat(process.env.DEPOSIT_FEE_FIXED || '0');
let SWEEP_FEE = parseFloat(process.env.SWEEP_FEE || '0');
let DEMO_ENABLED = process.env.DEMO_ENABLED !== 'false';
let DEMO_BALANCE = parseFloat(process.env.DEMO_BALANCE || '10000');
let TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS || '5000', 10);
let WAITING_DURATION_MS = 7000, CRASH_DURATION_MS = 3000;
let GROWTH_RATE = 0.06, MAX_CHART_POINTS = 500, MAX_HISTORY = 50;

// ═══ Config Helpers ═══
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
function deepMerge(base, override) {
    if (Array.isArray(override)) return override.slice();
    if (typeof override !== 'object' || override === null) return override;
    const result = Array.isArray(base) ? base.slice() : { ...base };
    for (const key of Object.keys(override)) {
        if (FORBIDDEN_KEYS.includes(key)) continue;
        const bv = result[key], ov = override[key];
        if (typeof ov === 'object' && ov !== null && !Array.isArray(ov) && typeof bv === 'object' && bv !== null && !Array.isArray(bv)) {
            result[key] = deepMerge(bv, ov);
        } else {
            result[key] = ov;
        }
    }
    return result;
}

function getPublicConfig() {
    const pub = JSON.parse(JSON.stringify(UI_CONFIG));
    if (pub.features) { delete pub.features.pseudoRandomConfig; }
    return pub;
}

function syncRuntimeConfigVariables() {
    const gs = UI_CONFIG.gameSettings || {};
    if (gs.minBet != null) MIN_BET = parseFloat(gs.minBet);
    if (gs.maxBet != null) MAX_BET = parseFloat(gs.maxBet);
    if (gs.minWithdrawal != null) MIN_WITHDRAWAL = parseFloat(gs.minWithdrawal);
    if (gs.maxWithdrawal != null) MAX_WITHDRAWAL = parseFloat(gs.maxWithdrawal);
    if (gs.minDeposit != null) MIN_DEPOSIT = parseFloat(gs.minDeposit);
    if (gs.depositFee != null) DEPOSIT_FEE = parseFloat(gs.depositFee);
    if (gs.depositFeeFixed != null) DEPOSIT_FEE_FIXED = parseFloat(gs.depositFeeFixed);
    if (gs.sweepFee != null) SWEEP_FEE = parseFloat(gs.sweepFee);
    if (gs.demoBalance != null) DEMO_BALANCE = parseFloat(gs.demoBalance);
    if (gs.demoEnabled != null) DEMO_ENABLED = Boolean(gs.demoEnabled);
    if (gs.waitingDuration != null) WAITING_DURATION_MS = parseInt(gs.waitingDuration, 10) || 7000;
    if (gs.crashDuration != null) CRASH_DURATION_MS = parseInt(gs.crashDuration, 10) || 3000;
    if (gs.growthRate != null) GROWTH_RATE = parseFloat(gs.growthRate) || 0.06;
    if (gs.maxChartPoints != null) MAX_CHART_POINTS = parseInt(gs.maxChartPoints, 10) || 500;
    if (gs.maxHistory != null) MAX_HISTORY = parseInt(gs.maxHistory, 10) || 50;
}

async function saveAppConfig(newConfig) {
    const newVersion = `${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    const merged = deepMerge(DEFAULT_UI_CONFIG, newConfig || {});
    merged.version = newVersion;
    merged.lastUpdated = new Date().toISOString();

    if (!merged.features || typeof merged.features !== 'object') {
        merged.features = { ...DEFAULT_UI_CONFIG.features };
    }
    merged.features.pseudoRandomMode = true;
    if (typeof merged.features.pseudoRandomConfig !== 'object' || merged.features.pseudoRandomConfig === null) {
        merged.features.pseudoRandomConfig = { enabled: true };
    } else {
        merged.features.pseudoRandomConfig.enabled = true;
    }

    const { data, error } = await supabase
        .from('config')
        .upsert(
            {
                id: 1,
                config: merged,
                version: newVersion,
                updated_at: new Date().toISOString()
            },
            { onConflict: 'id' }
        )
        .select('id, version, updated_at')
        .single();

    if (error) {
        logCritical('❌ saveAppConfig upsert failed:', error.message);
        throw new Error(`CONFIG_UPSERT_FAILED: ${error.message}`);
    }

    UI_CONFIG = merged;
    syncRuntimeConfigVariables();

    if (typeof io !== 'undefined' && io) {
        try {
            io.emit('config_updated', {
                version: newVersion,
                config: getPublicConfig(),
                effective: { minBet: MIN_BET, maxBet: MAX_BET }
            });
        } catch (e) {}
    }

    return { version: newVersion, config: UI_CONFIG, row: data };
}

async function loadAppConfig() {
    try {
        const { data, error } = await supabase.from('config').select('config, version').eq('id', 1).maybeSingle();
        if (error) {
            logCritical('❌ loadAppConfig query error:', error.message);
            return;
        }
        if (data?.config) {
            UI_CONFIG = deepMerge(DEFAULT_UI_CONFIG, data.config);
            UI_CONFIG.version = data.version || UI_CONFIG.version;
            if (!UI_CONFIG.features || typeof UI_CONFIG.features !== 'object') {
                UI_CONFIG.features = { ...DEFAULT_UI_CONFIG.features };
            }
            UI_CONFIG.features.pseudoRandomMode = true;
            if (typeof UI_CONFIG.features.pseudoRandomConfig !== 'object' || UI_CONFIG.features.pseudoRandomConfig === null) {
                UI_CONFIG.features.pseudoRandomConfig = { enabled: true };
            } else {
                UI_CONFIG.features.pseudoRandomConfig.enabled = true;
            }
            syncRuntimeConfigVariables();
        }
    } catch (e) {
        logCritical('❌ loadAppConfig:', e.message);
    }
}

// ═══ Anti-Collusion ═══
const ipToUserIds = new Map(), deviceToUserIds = new Map(), userIdToDevices = new Map(), userIdToIPs = new Map(), suspiciousCollusionPairs = new Set(), colorSelectionHistory = new Map();
function recordIP(userId, ip) { if (!IP_CONSISTENCY_ENABLED || !ip) return; if (!ipToUserIds.has(ip)) ipToUserIds.set(ip, new Set()); ipToUserIds.get(ip).add(userId); if (!userIdToIPs.has(userId)) userIdToIPs.set(userId, new Set()); userIdToIPs.get(userId).add(ip); }
function recordDevice(userId, deviceFp) { if (!DEVICE_FP_ENABLED || !deviceFp) return; if (!deviceToUserIds.has(deviceFp)) deviceToUserIds.set(deviceFp, new Set()); deviceToUserIds.get(deviceFp).add(userId); if (!userIdToDevices.has(userId)) userIdToDevices.set(userId, new Set()); userIdToDevices.get(userId).add(deviceFp); }
function detectCollusion(userA, userB) { const ipsA = userIdToIPs.get(userA) || new Set(), ipsB = userIdToIPs.get(userB) || new Set(); const devicesA = userIdToDevices.get(userA) || new Set(), devicesB = userIdToDevices.get(userB) || new Set(); const sharedIPs = [...ipsA].filter(ip => ipsB.has(ip)), sharedDevices = [...devicesA].filter(d => devicesB.has(d)); if (sharedIPs.length > 0 || sharedDevices.length > 0) { const pairKey = [userA, userB].sort().join(':'); if (!suspiciousCollusionPairs.has(pairKey)) { suspiciousCollusionPairs.add(pairKey); logCritical(`🚨 [COLLUSION] Detected: ${userA} ↔ ${userB}`); if (typeof io !== 'undefined' && io) io.to('admin_room').emit('collusion_alert', { userA, userB, sharedIPs, sharedDevices, timestamp: new Date().toISOString() }); } return true; } return false; }
function checkMultiAccount(userId, ip, deviceFp) { if (IP_CONSISTENCY_ENABLED && ip) { const otherUsers = ipToUserIds.get(ip) || new Set(); for (const otherUser of otherUsers) { if (otherUser !== userId) { detectCollusion(userId, otherUser); return { suspicious: true, reason: 'MULTI_ACCOUNT_IP', sharedWith: otherUser }; } } } if (DEVICE_FP_ENABLED && deviceFp) { const otherUsers = deviceToUserIds.get(deviceFp) || new Set(); for (const otherUser of otherUsers) { if (otherUser !== userId) { detectCollusion(userId, otherUser); return { suspicious: true, reason: 'MULTI_ACCOUNT_DEVICE', sharedWith: otherUser }; } } } return { suspicious: false }; }
function recordColorChoice(userId, colorType) { if (!colorSelectionHistory.has(userId)) colorSelectionHistory.set(userId, []); const history = colorSelectionHistory.get(userId); history.push({ colorType, timestamp: Date.now() }); if (history.length > 20) history.shift(); }
function detectColorCollusion(userIds) { if (userIds.length < 2) return false; for (let i = 0; i < userIds.length; i++) { for (let j = i + 1; j < userIds.length; j++) { const histA = colorSelectionHistory.get(userIds[i]) || []; const histB = colorSelectionHistory.get(userIds[j]) || []; if (histA.length < 5 || histB.length < 5) continue; let oppositeCount = 0; for (let k = 0; k < Math.min(5, histA.length, histB.length); k++) { const aColor = histA[histA.length - 1 - k].colorType; const bColor = histB[histB.length - 1 - k].colorType; if ((aColor === 'red' && bColor === 'green') || (aColor === 'green' && bColor === 'red')) oppositeCount++; } if (oppositeCount >= 4) { const pairKey = [userIds[i], userIds[j]].sort().join(':'); if (!suspiciousCollusionPairs.has(pairKey)) { suspiciousCollusionPairs.add(pairKey); logCritical(`🚨 [COLOR-COLLUSION] Detected: ${userIds[i]} ↔ ${userIds[j]}`); if (typeof io !== 'undefined' && io) io.to('admin_room').emit('collusion_alert', { userA: userIds[i], userB: userIds[j], pattern: 'OPPOSITE_COLOR_PATTERN', timestamp: new Date().toISOString() }); } return true; } } } return false; }

// ═════════════════════════════════════════════════════════════════
// 🛡️ BET PROTECTION SYSTEM
// ═════════════════════════════════════════════════════════════════
const DISCONNECT_TIMEOUT_MS = 3 * 60 * 1000;
const RECOVERY_MIN_AGE_MS = 5 * 60 * 1000;

async function recoverPendingBets() {
    try {
        logCritical('🔄 [RECOVERY] Checking for pending bets...');
        const { data: pendingBets } = await supabase.from('bets').select('*').eq('payout', 0).eq('won', false).eq('crash_point', 0).lt('created_at', new Date(Date.now() - RECOVERY_MIN_AGE_MS).toISOString());
        if (!pendingBets || pendingBets.length === 0) { logCritical('✅ [RECOVERY] No pending bets'); return { recovered: 0 }; }
        logCritical(`🔄 [RECOVERY] Found ${pendingBets.length} pending bets`);
        let recovered = 0;
        for (const bet of pendingBets) {
            try {
                const { data: round } = await supabase.from('rounds').select('*').eq('round_id', bet.round_id).maybeSingle();
                if (round && round.ended_at) {
                    const crashPoint = parseFloat(round.crash_point);
                    const { data: currentBet } = await supabase.from('bets').select('payout, won, crash_point').eq('bet_id', bet.bet_id).maybeSingle();
                    if (currentBet && currentBet.payout > 0) continue;
                    await supabase.from('bets').update({ payout: 0, won: false, crash_point: crashPoint }).eq('bet_id', bet.bet_id);
                    recovered++;
                } else if (!round) {
                    const user = await getUser(bet.user_id);
                    if (user) {
                        const refund = await atomicCreditBalance(bet.user_id, parseFloat(bet.amount));
                        if (refund.success) {
                            await supabase.from('bets').update({ payout: parseFloat(bet.amount), won: false, crash_point: 1.0 }).eq('bet_id', bet.bet_id);
                            await logRefund(bet.user_id, parseFloat(bet.amount), 'RECOVERY_REFUND', { betId: bet.bet_id });
                            recovered++;
                        }
                    }
                }
            } catch (e) { logCritical(`❌ [RECOVERY] Error: ${e.message}`); }
        }
        return { recovered };
    } catch (e) { logCritical('❌ [RECOVERY] Failed:', e.message); return { recovered: 0, error: e.message }; }
}

const processedBetIds = new Map();
const PROCESSED_BET_TTL_MS = 10 * 60 * 1000;
function isBetAlreadyProcessed(betId) { const timestamp = processedBetIds.get(betId); if (!timestamp) return false; if (Date.now() - timestamp > PROCESSED_BET_TTL_MS) { processedBetIds.delete(betId); return false; } return true; }
function markBetAsProcessed(betId) { processedBetIds.set(betId, Date.now()); }
setInterval(() => { const now = Date.now(); for (const [betId, timestamp] of processedBetIds) { if (now - timestamp > PROCESSED_BET_TTL_MS) processedBetIds.delete(betId); } }, 60 * 1000);

const disconnectedPlayers = new Map();
function trackPlayerDisconnect(userId, betIds, socketId) { disconnectedPlayers.set(userId, { disconnectedAt: Date.now(), betIds: betIds || [], socketId }); }
function trackPlayerReconnect(userId, socketId) { const d = disconnectedPlayers.get(userId); if (d) { const duration = Date.now() - d.disconnectedAt; if (duration < DISCONNECT_TIMEOUT_MS) return { reconnected: true, duration, canCashOut: true }; disconnectedPlayers.delete(userId); return { reconnected: true, duration, canCashOut: false }; } return { reconnected: false }; }

async function processUnclaimedBets(roundId, crashPoint) {
    try {
        const { data: unclaimedBets } = await supabase.from('bets').select('*').eq('round_id', roundId).eq('payout', 0).eq('won', false);
        if (!unclaimedBets || unclaimedBets.length === 0) return { processed: 0 };
        let processed = 0;
        for (const bet of unclaimedBets) {
            try {
                const { data: currentBet } = await supabase.from('bets').select('payout, won, crash_point').eq('bet_id', bet.bet_id).maybeSingle();
                if (currentBet && (currentBet.payout > 0 || currentBet.won || currentBet.crash_point > 0)) continue;
                const betType = bet.bet_type;
                let won = false, targetMultiplier = 0, grossPayout = 0;
                if (betType.startsWith('COLOR_')) { const color = betType.replace('COLOR_', '').toLowerCase(); targetMultiplier = COLOR_BETS[color]?.multiplier || 0; won = evaluateColorWin(color, crashPoint); if (won) grossPayout = parseFloat(bet.amount) * targetMultiplier; }
                else if (betType.startsWith('TRENBALL_')) { const color = betType.replace('TRENBALL_', '').toLowerCase(); targetMultiplier = TRENBALL_BETS[color]?.multiplier || 0; won = evaluateColorWin(color, crashPoint); if (won) grossPayout = parseFloat(bet.amount) * targetMultiplier; }
                const { data: updated } = await supabase.from('bets').update({ payout: grossPayout, won, crash_point: crashPoint }).eq('bet_id', bet.bet_id).eq('payout', 0).select().maybeSingle();
                if (!updated) continue;
                if (won && grossPayout > 0) {
                    const credit = await atomicCreditBalance(bet.user_id, grossPayout);
                    if (credit.success) {
                        const freshUser = await getUser(bet.user_id);
                        if (freshUser) await supabase.from('users').update({ total_won: parseFloat(freshUser.total_won || 0) + grossPayout }).eq('user_id', bet.user_id);
                        if (typeof io !== 'undefined' && io) io.to(`user_${bet.user_id}`).emit('bet_recovered', { betId: bet.bet_id, won: true, winAmount: grossPayout, newBalance: credit.newBalance, message: MESSAGES.GAME.BET_RECOVERED });
                    }
                }
                processed++;
            } catch (e) { logCritical(`❌ [UNCLAIMED] Error: ${e.message}`); }
        }
        return { processed };
    } catch (e) { return { processed: 0, error: e.message }; }
}

// ═══ Game State ═══
let currentRound = null;
let currentMultiplier = 1.00;
let gamePhase = 'waiting';
let countdownEndsAt = 0;
const roundBets = new Map();
let currentChartPoints = [{ x: 0, y: 1.0 }];
let recentHistory = [];
const activePlayers = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getCurrentPlayersPayload() {
    const players = [];
    for (const [, p] of activePlayers) {
        if (!p.slots) continue;
        for (const slot of p.slots) {
            players.push({ userId: p.userId, name: p.name, betType: slot.type, color: slot.color || null, trenballColor: slot.trenballColor || null, cashedOutAt: slot.cashedOut, cashOutMultiplier: slot.cashOutMultiplier, atMultiplier: slot.cashedOut ? slot.cashOutMultiplier : currentMultiplier, amount: slot.originalAmount, isDemo: slot.isDemo });
        }
    }
    return players;
}

let _lastPlayersHash = '';
let _lastPlayersBroadcastTime = 0;
const PLAYERS_UPDATE_INTERVAL_MS = parseInt(process.env.PLAYERS_UPDATE_INTERVAL_MS || '15000', 10);
function broadcastPlayers(force = false) {
    if (typeof io === 'undefined' || !io) return;
    try {
        const now = Date.now();
        if (!force && now - _lastPlayersBroadcastTime < PLAYERS_UPDATE_INTERVAL_MS) return;
        const payload = getCurrentPlayersPayload();
        const hash = JSON.stringify(payload);
        if (!force && hash === _lastPlayersHash) return;
        _lastPlayersHash = hash;
        _lastPlayersBroadcastTime = now;
        io.volatile.emit('players_update', { players: payload });
    } catch (e) {}
}

// ═════════════════════════════════════════════════════════════════
// 🧠 SMART ADAPTIVE ENGINE
// ═════════════════════════════════════════════════════════════════
function calculateBetFactor(amount) { return Math.min(1, amount / MAX_BET_LIMIT); }
function calculateHistoryFactor(winRate) { if (winRate <= 0.40) return 0.15; if (winRate <= 0.50) return 0.30; if (winRate <= 0.60) return 0.50; if (winRate <= 0.70) return 0.70; if (winRate <= 0.80) return 0.85; return 1.0; }
function calculateTimeFactor(activePlayersCount) { if (activePlayersCount <= 1) return 1.0; if (activePlayersCount <= 3) return 0.85; if (activePlayersCount <= 5) return 0.70; if (activePlayersCount <= 10) return 0.50; if (activePlayersCount <= 20) return 0.35; return 0.25; }
function calculateOwnerFactor(dailyNetLoss) { if (dailyNetLoss >= 1000) return 1.0; if (dailyNetLoss >= 500) return 0.85; if (dailyNetLoss >= 200) return 0.70; if (dailyNetLoss >= 0) return 0.50; if (dailyNetLoss >= -200) return 0.35; return 0.20; }
function calculateBehaviorFactor(behaviorScore) { return Math.min(1, behaviorScore / 100); }

// ═════════════════════════════════════════════════════════════════
// 🎲 PRM ENGINE
// ═════════════════════════════════════════════════════════════════
async function pickPseudoRandomCrashPoint(baseCrashPoint, roundSeed, baseClientSeed, nonce) {
    if (!roundSeed || !baseClientSeed) return { crashPoint: baseCrashPoint, clientSeed: baseClientSeed, isDirected: false };
    let totalRed = 0, totalGreen = 0, totalYellow = 0;
    const classicBets = [], realPlayerBets = [];
    let totalPool = 0, hasBets = false;
    for (const [, player] of activePlayers) { if (!player.slots) continue; for (const slot of player.slots) { if (slot.isDemo) continue; hasBets = true; totalPool += slot.originalAmount; if (slot.type === 'CLASSIC') { const autoCashOut = slot.autoCashOut || 2.00; classicBets.push({ amount: slot.originalAmount, autoCashOut, userId: slot.userId }); } const c = (slot.color || slot.trenballColor || '').toLowerCase(); const amt = slot.originalAmount; if (c === 'red') totalRed += amt; else if (c === 'green') totalGreen += amt; else if (c === 'yellow' || c === 'moon') totalYellow += amt; realPlayerBets.push({ userId: slot.userId, amount: amt, color: c, type: slot.type, autoCashOut: slot.autoCashOut || null, trenballColor: slot.trenballColor || null }); } }
    if (!hasBets) return { crashPoint: baseCrashPoint, clientSeed: baseClientSeed, isDirected: false };
    const userHistoryMap = new Map();
    try {
        const userIds = [...new Set(realPlayerBets.map(b => b.userId))];
        const { data: users } = await supabase.from('users').select('user_id, total_won, total_wagered, balance, total_deposited, is_flagged').in('user_id', userIds);
        if (users) for (const u of users) { const wagered = parseFloat(u.total_wagered || 0), won = parseFloat(u.total_won || 0); const behaviorScore = behaviorTracker.analyze(u.user_id)?.score || 0; userHistoryMap.set(u.user_id, { winRate: wagered > 0 ? won / wagered : 0, balance: parseFloat(u.balance || 0), deposited: parseFloat(u.total_deposited || 0), isFlagged: u.is_flagged === true, behaviorScore }); }
    } catch (e) { logCritical('❌ PRM user history:', e.message); }
    const uniqueUserIds = [...new Set(realPlayerBets.map(b => b.userId))];
    if (uniqueUserIds.length >= 2) { detectColorCollusion(uniqueUserIds); for (let i = 0; i < uniqueUserIds.length; i++) for (let j = i + 1; j < uniqueUserIds.length; j++) detectCollusion(uniqueUserIds[i], uniqueUserIds[j]); }
    const activePlayersCount = uniqueUserIds.length;
    const dailyNetLoss = dailyLossTracker.totalLoss - dailyLossTracker.totalWin;
    let maxBetAmount = 0, maxWinRate = 0, maxBehaviorScore = 0;
    for (const bet of realPlayerBets) { const h = userHistoryMap.get(bet.userId); if (!h) continue; if (bet.amount > maxBetAmount) maxBetAmount = bet.amount; if (h.winRate > maxWinRate) maxWinRate = h.winRate; if (h.behaviorScore > maxBehaviorScore) maxBehaviorScore = h.behaviorScore; }
    const overallProtection = calculateBetFactor(maxBetAmount) * 0.30 + calculateHistoryFactor(maxWinRate) * 0.25 + calculateOwnerFactor(dailyNetLoss) * 0.20 + calculateTimeFactor(activePlayersCount) * 0.15 + calculateBehaviorFactor(maxBehaviorScore) * 0.10;
    const dynamicConfig = { flaggedPenalty: 2 + overallProtection * 3, fairnessWindow: 0.30 - overallProtection * 0.15, aggressiveness: 0.25 + overallProtection * 0.50, maxDeviation: 1.5 + overallProtection * 2.0, smartProtectLevel: overallProtection > 0.75 ? 'AGGRESSIVE' : overallProtection > 0.50 ? 'MEDIUM' : overallProtection > 0.25 ? 'LIGHT' : 'NONE', protectionScore: overallProtection };
    logCritical(`🧠 SmartProtection: score=${overallProtection.toFixed(2)} level=${dynamicConfig.smartProtectLevel}`);
    const fairnessRoll = provablyFair.computeCrashPoint(roundSeed, `${baseClientSeed}-fairness-${nonce}`);
    if (fairnessRoll <= 1 + dynamicConfig.fairnessWindow * 9) return { crashPoint: baseCrashPoint, clientSeed: baseClientSeed, isDirected: false };
    const classicBetsWithProtection = classicBets.map(bet => { let finalAutoCashOut = bet.autoCashOut; const h = userHistoryMap.get(bet.userId); if (h && h.winRate > 0.55 && bet.amount >= 10) { if (dynamicConfig.smartProtectLevel === 'AGGRESSIVE') finalAutoCashOut = Math.min(bet.autoCashOut, 1.55); else if (dynamicConfig.smartProtectLevel === 'MEDIUM') finalAutoCashOut = Math.min(bet.autoCashOut, 1.70); else if (dynamicConfig.smartProtectLevel === 'LIGHT') finalAutoCashOut = Math.min(bet.autoCashOut, 1.85); } return { ...bet, autoCashOut: finalAutoCashOut }; });
    for (const [, player] of activePlayers) { if (!player.slots) continue; for (const slot of player.slots) { if (slot.isDemo) continue; const isColor = (slot.type === 'COLOR' && slot.color), isTrenball = (slot.type === 'TRENBALL' && slot.trenballColor); if (!isColor && !isTrenball) continue; const color = isColor ? slot.color : slot.trenballColor; const h = userHistoryMap.get(slot.userId); if (!h) continue; if (h.winRate > 0.60 && slot.originalAmount >= 10) { const boost = slot.originalAmount * Math.min(1, h.winRate - 0.55) * overallProtection; if (color === 'red') totalRed += boost; else if (color === 'green') totalGreen += boost; else if (color === 'yellow' || color === 'moon') totalYellow += boost; } } }
    function evaluateHouseProfit(cp) {
        let profit = 0;
        if (cp < 2.00) profit -= totalRed * 1.96; else profit += totalRed;
        if (cp >= 2.00 && cp < 10.00) profit -= totalGreen * 2.00; else profit += totalGreen;
        if (cp >= 10.00) profit -= totalYellow * 10.00; else profit += totalYellow;
        for (const bet of classicBetsWithProtection) { if (cp >= bet.autoCashOut) profit -= bet.amount * bet.autoCashOut; else profit += bet.amount; }
        for (const bet of realPlayerBets) { const h = userHistoryMap.get(bet.userId); if (!h) continue; if (bet.type === 'CLASSIC' && bet.autoCashOut) { const weight = Math.max(0, h.winRate - 0.45); if (cp >= bet.autoCashOut) profit -= bet.amount * weight * (1 + overallProtection * 2); else profit += bet.amount * weight * 0.5; } if ((bet.type === 'COLOR' || bet.type === 'TRENBALL') && bet.color) { if (h.winRate > 0.45) { const wouldWin = evaluateColorWin(bet.color, cp); const weight = Math.max(0, h.winRate - 0.45); if (wouldWin) profit -= bet.amount * weight * (1 + overallProtection * 2); else profit += bet.amount * weight * 1.5; } } }
        for (const bet of realPlayerBets) { const h = userHistoryMap.get(bet.userId); if (h?.isFlagged) { const wouldWin = (bet.type === 'COLOR' || bet.type === 'TRENBALL') ? evaluateColorWin(bet.color, cp) : (cp >= bet.autoCashOut); if (wouldWin) profit -= bet.amount * dynamicConfig.flaggedPenalty; else profit += bet.amount * 2; } }
        if (totalPool > 0) profit *= (1 + overallProtection * Math.min(1, totalPool / 100) * 0.3);
        return profit;
    }
    const maxCp = Math.max(baseCrashPoint, 1.01) * dynamicConfig.maxDeviation;
    let best = { crashPoint: baseCrashPoint, clientSeed: baseClientSeed, profit: evaluateHouseProfit(baseCrashPoint) };
    const candidates = [];
    for (let i = 0; i < 500; i++) { const candidateSeed = `${baseClientSeed}-prm-${i}-${nonce}`; let cp = provablyFair.computeCrashPoint(roundSeed, candidateSeed); cp = Math.max(1.00, Math.min(maxCp, cp)); candidates.push({ crashPoint: cp, clientSeed: candidateSeed, profit: evaluateHouseProfit(cp) }); }
    candidates.sort((a, b) => b.profit - a.profit);
    const topTierSize = Math.max(3, Math.floor(candidates.length * (0.15 + dynamicConfig.aggressiveness * 0.15)));
    const topTier = candidates.slice(0, topTierSize);
    const chosen = topTier[Math.floor(Math.random() * topTier.length)];
    if (chosen.profit > best.profit + Math.max(0.5, totalPool) * 0.01) best = chosen;
    logCritical(`🎲 PRM: fair=${baseCrashPoint.toFixed(2)} → directed=${best.crashPoint.toFixed(2)}`);
    return { crashPoint: best.crashPoint, clientSeed: best.clientSeed, isDirected: best.crashPoint !== baseCrashPoint };
}

// ═════════════════════════════════════════════════════════════════
// 💰 Owner Profit
// ═════════════════════════════════════════════════════════════════
async function settleDeferredDeficitFromSurplus(surplusAmount) {
    if (surplusAmount <= 0) return { settledTotal: 0, remainingSurplus: surplusAmount, settledCount: 0 };
    let remainingSurplus = surplusAmount, settledTotal = 0, settledCount = 0;
    try { const { data: pendingDeficits } = await supabase.from('owner_deferred_deficit').select('*').eq('status', 'pending').order('created_at', { ascending: true }); if (!pendingDeficits || pendingDeficits.length === 0) return { settledTotal: 0, remainingSurplus, settledCount: 0 }; for (const d of pendingDeficits) { if (remainingSurplus <= 0) break; const deficitAmt = parseFloat(d.deficit_amount) || 0; if (deficitAmt <= 0) continue; if (remainingSurplus >= deficitAmt) { const { data: updated } = await supabase.from('owner_deferred_deficit').update({ status: 'settled', settled_at: new Date().toISOString(), settled_amount: deficitAmt }).eq('id', d.id).eq('status', 'pending').select().maybeSingle(); if (updated) { remainingSurplus -= deficitAmt; settledTotal += deficitAmt; settledCount++; } } else { const newRemaining = deficitAmt - remainingSurplus; const partialSettled = remainingSurplus; const { data: updated } = await supabase.from('owner_deferred_deficit').update({ deficit_amount: newRemaining, settled_amount: (parseFloat(d.settled_amount) || 0) + partialSettled }).eq('id', d.id).eq('status', 'pending').select().maybeSingle(); if (updated) { settledTotal += partialSettled; remainingSurplus = 0; settledCount++; } } } } catch (e) { logCritical('❌ settle error:', e.message); }
    return { settledTotal, remainingSurplus, settledCount };
}
async function applyOwnerProfit(roundId, totalRealPool, actualRealPaid) {
    try {
        const ownerCommission = totalRealPool * OWNER_POOL_SHARE;
        const prizePool = totalRealPool - ownerCommission;
        let deficitAmount = 0, surplusAmount = 0;
        if (actualRealPaid > prizePool) deficitAmount = actualRealPaid - prizePool; else surplusAmount = prizePool - actualRealPaid;
        let deficitSettledNow = 0, effectiveSurplus = surplusAmount;
        if (surplusAmount > 0) { const settlement = await settleDeferredDeficitFromSurplus(surplusAmount); deficitSettledNow = settlement.settledTotal; effectiveSurplus = settlement.remainingSurplus; }
        const ownerGain = ownerCommission + effectiveSurplus;
        const { data: rpcResult, error: rpcErr } = await supabase.rpc('atomic_update_owner_balance', { p_commission: ownerCommission, p_deficit: deficitAmount, p_settled: deficitSettledNow, p_gain: ownerGain });
        if (rpcErr || !rpcResult?.success) { logCritical('❌ atomic_update_owner_balance:', rpcErr?.message); recordCriticalError('atomic_update_owner_balance: ' + (rpcErr?.message || 'unknown')); return { ownerGain: 0, deficitAmount, ownerCommission, surplusAmount, effectiveSurplus, deficitSettled: 0 }; }
        if (deficitAmount > 0) await safeSupabase(supabase.from('owner_deferred_deficit').insert({ round_id: roundId, gross_commission: ownerCommission, payouts_paid: actualRealPaid, deficit_amount: deficitAmount, settled_amount: 0, status: 'pending', created_at: new Date().toISOString() }), 'INSERT_OWNER_DEFICIT');
        await safeSupabase(supabase.from('owner_profits').insert({ round_id: roundId, amount: ownerGain, commission_rate: OWNER_POOL_SHARE, total_bets: totalRealPool, total_payouts: actualRealPaid, net_profit: totalRealPool - actualRealPaid, deficit_amount: deficitAmount, surplus_amount: surplusAmount, created_at: new Date().toISOString() }), 'INSERT_OWNER_PROFIT');
        trackLoss(-(totalRealPool - actualRealPaid));
        return { ownerGain, deficitAmount, ownerCommission, surplusAmount, effectiveSurplus, deficitSettled: deficitSettledNow };
    } catch (err) { logCritical('❌ applyOwnerProfit:', err.message); return { ownerGain: 0, deficitAmount: 0, ownerCommission: 0, surplusAmount: 0, effectiveSurplus: 0, deficitSettled: 0 }; }
}
async function getOwnerFinancialState() {
    try {
        const { data: balanceRow } = await supabase.from('owner_balance').select('*').eq('id', 1).maybeSingle();
        let totalDeficit = 0;
        try { const { data: sumData, error: sumErr } = await supabase.rpc('get_total_pending_deficit'); if (!sumErr && sumData !== null && sumData !== undefined) totalDeficit = parseFloat(sumData) || 0; else { const { data: deficits } = await supabase.from('owner_deferred_deficit').select('deficit_amount').eq('status', 'pending'); totalDeficit = (deficits || []).reduce((s, d) => s + (parseFloat(d.deficit_amount) || 0), 0); } } catch (_) { const { data: deficits } = await supabase.from('owner_deferred_deficit').select('deficit_amount').eq('status', 'pending'); totalDeficit = (deficits || []).reduce((s, d) => s + (parseFloat(d.deficit_amount) || 0), 0); }
        const balance = parseFloat(balanceRow?.balance) || 0;
        return { balance, totalDeficit, withdrawable: Math.max(0, balance - totalDeficit), totalCommission: parseFloat(balanceRow?.total_commission) || 0, totalSettled: parseFloat(balanceRow?.total_settled) || 0 };
    } catch (e) { return { balance: 0, totalDeficit: 0, withdrawable: 0, totalCommission: 0, totalSettled: 0 }; }
}

// ═════════════════════════════════════════════════════════════════
// 🛡️ POL Monitoring
// ═════════════════════════════════════════════════════════════════
async function monitorPolEnhanced() {
    try { const balanceWei = await provider.getBalance(adminWallet.address); const pol = parseFloat(ethers.formatEther(balanceWei)); let level = 'SAFE'; if (pol <= POL_THRESHOLDS.CRITICAL) level = 'CRITICAL'; else if (pol <= POL_THRESHOLDS.DANGER) level = 'DANGER'; else if (pol <= POL_THRESHOLDS.WARNING) level = 'WARNING'; else if (pol <= POL_THRESHOLDS.SAFE) level = 'NORMAL'; currentPolState = { balance: pol, level, lastUpdate: new Date().toISOString(), withdrawalsPaused: false }; if (level === 'CRITICAL' && typeof io !== 'undefined' && io) io.to('admin_room').emit('pol_critical_alert', { level: 'CRITICAL', balance: pol, threshold: POL_THRESHOLDS.CRITICAL, message: '🚨 POL CRITICAL — Refill immediately', withdrawalsPaused: false, gameStillRunning: true, action: 'REFILL_IMMEDIATELY', timestamp: new Date().toISOString() }); else if (level === 'DANGER' && typeof io !== 'undefined' && io) io.to('admin_room').emit('pol_danger_alert', { level: 'DANGER', balance: pol, threshold: POL_THRESHOLDS.DANGER, message: '⚠️ POL DANGER — Refill soon', withdrawalsPaused: false, gameStillRunning: true, action: 'REFILL_SOON', timestamp: new Date().toISOString() }); return { pol, level }; }
    catch (e) { logCritical('❌ monitorPolEnhanced error:', e.message); return { pol: 0, level: 'ERROR' }; }
}

async function loadRecentHistory() { try { const { data } = await supabase.from('rounds').select('crash_point, ended_at').not('ended_at', 'is', null).order('ended_at', { ascending: false }).limit(20); if (data) recentHistory = data.map(r => ({ crashPoint: parseFloat(r.crash_point), timestamp: new Date(r.ended_at).getTime() })); } catch (e) { logCritical('❌ loadRecentHistory:', e.message); } }
async function processPendingRefunds() { try { const { data: refunds } = await supabase.from('refunds').select('*').eq('status', 'pending').limit(50); if (!refunds || refunds.length === 0) return; for (const r of refunds) { const { data: claimed } = await supabase.from('refunds').update({ status: 'processing', locked_at: new Date().toISOString() }).eq('id', r.id).eq('status', 'pending').select().maybeSingle(); if (!claimed) continue; try { const credit = await atomicCreditBalance(r.user_id, parseFloat(r.amount)); if (!credit.success) { await supabase.from('refunds').update({ status: 'pending', locked_at: null }).eq('id', r.id); continue; } await supabase.from('refunds').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', r.id); if (typeof io !== 'undefined' && io) io.to(`user_${r.user_id}`).emit('refund_completed', { amount: parseFloat(r.amount), newBalance: credit.newBalance, message: '✅ تم إرجاع المبلغ' }); } catch (err) { await supabase.from('refunds').update({ status: 'pending', locked_at: null }).eq('id', r.id); } } } catch (e) {} }
async function processPendingPayouts() { try { const { data: pending } = await supabase.from('pending_payouts').select('*').eq('processed', false).limit(100); if (!pending || pending.length === 0) return; for (const p of pending) { const { data: claimed } = await supabase.from('pending_payouts').update({ processed: true, processed_at: new Date().toISOString() }).eq('id', p.id).eq('processed', false).select().maybeSingle(); if (!claimed) continue; const user = await getUser(p.user_id); if (!user) { await supabase.from('pending_payouts').update({ reason: 'USER_DELETED_PERMANENTLY', processed: true }).eq('id', p.id); continue; } try { const credit = await atomicCreditBalance(p.user_id, parseFloat(p.amount)); if (!credit.success) { await supabase.from('pending_payouts').update({ processed: false }).eq('id', p.id); continue; } await supabase.from('users').update({ total_won: parseFloat(user.total_won || 0) + parseFloat(p.amount) }).eq('user_id', p.user_id); if (typeof io !== 'undefined' && io) io.to(`user_${p.user_id}`).emit('payout_recovered', { amount: parseFloat(p.amount), newBalance: credit.newBalance, message: '✅ تم استرداد أرباحك' }); } catch (err) { await supabase.from('pending_payouts').update({ processed: false }).eq('id', p.id); } } } catch (e) {} }
async function logPendingSweep(userId, userAddress, amount, error, txHash = null) { try { await supabase.from('pending_sweeps').insert({ user_id: userId, user_address: userAddress, amount, tx_hash_received: txHash, status: 'pending', last_error: error, next_retry_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() }); } catch (e) {} }
async function processPendingSweeps() {
    try {
        const ownerPolWei = await provider.getBalance(adminWallet.address);
        const ownerPol = parseFloat(ethers.formatEther(ownerPolWei));
        if (ownerPol < 0.1 && typeof io !== 'undefined' && io) io.to('admin_room').emit('sweep_low_pol', { pol: ownerPol, timestamp: new Date().toISOString() });
        const now = new Date().toISOString();
        const { data: pending } = await supabase.from('pending_sweeps').select('*').in('status', ['pending', 'failed']).lt('attempts', 5).or(`next_retry_at.lte.${now},and(status.eq.processing,locked_until.lte.${now})`).limit(10);
        if (!pending || pending.length === 0) return;
        for (const p of pending) {
            const lockTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
            const { data: claimed } = await supabase.from('pending_sweeps').update({ status: 'processing', locked_until: lockTime }).eq('id', p.id).in('status', ['pending', 'failed', 'processing']).select().maybeSingle();
            if (!claimed) continue;
            const result = await sweepToAdmin(p.user_id, p.user_address, parseFloat(p.amount));
            if (result.success) await supabase.from('pending_sweeps').update({ status: 'completed', completed_at: new Date().toISOString(), locked_until: null }).eq('id', p.id);
            else { const attempts = (p.attempts || 0) + 1; const retryDelay = Math.min(60, 5 * Math.pow(2, attempts)); await supabase.from('pending_sweeps').update({ status: attempts >= 5 ? 'failed_permanent' : 'failed', attempts, last_error: result.reason, next_retry_at: new Date(Date.now() + retryDelay * 60 * 1000).toISOString(), locked_until: null }).eq('id', p.id); }
        }
    } catch (e) {}
}
async function monitorOwnerPol() { try { const balance = await provider.getBalance(adminWallet.address); const pol = parseFloat(ethers.formatEther(balance)); logCritical(`💰 POL: ${pol.toFixed(4)}`); if (pol < 0.5 && typeof io !== 'undefined' && io) io.to('admin_room').emit('pol_low', { pol }); } catch (e) {} }
async function ensureGasForUser(address) { try { const polBalance = await provider.getBalance(address); const feeData = await provider.getFeeData(); const gasPrice = feeData.gasPrice || ethers.parseUnits('100', 'gwei'); const gasLimit = 80000n; const minGas = gasPrice * gasLimit * 3n; const absoluteMin = ethers.parseEther('0.01'); const safeMinGas = minGas > absoluteMin ? minGas : absoluteMin; if (polBalance >= safeMinGas) return true; const ownerBalance = await provider.getBalance(adminWallet.address); const ownerPol = parseFloat(ethers.formatEther(ownerBalance)); const neededPol = parseFloat(ethers.formatEther(safeMinGas)); if (ownerPol < neededPol + 0.1) throw new Error(`OWNER_POL_INSUFFICIENT`); const tx = await adminWallet.sendTransaction({ to: address, value: safeMinGas }); await waitWithTimeout(tx, 120000); return true; } catch (e) { throw e; } }
async function sweepToAdmin(userId, userAddress, amountUSDT, txHashReceived = null) {
    try {
        if (SAFE_MODE) { logCritical('🛡️ [SAFE_MODE] Sweep blocked'); return { success: false, reason: 'SAFE_MODE' }; }
        const derived = paymentService.tryGetDepositAddress(userId);
        if (!derived || derived.toLowerCase() !== userAddress.toLowerCase()) { recordCriticalError('ADDRESS_MISMATCH in sweep'); return { success: false, reason: 'ADDRESS_MISMATCH' }; }
        let polBalance = await provider.getBalance(userAddress);
        const minRequiredPol = ethers.parseEther('0.005');
        if (polBalance < minRequiredPol) { try { await ensureGasForUser(userAddress); } catch (gasErr) { await logPendingSweep(userId, userAddress, amountUSDT, 'GAS_SEND_FAILED: ' + gasErr.message, txHashReceived); return { success: false, reason: 'GAS_SEND_FAILED' }; } let confirmed = false; for (let attempt = 1; attempt <= 6; attempt++) { await sleep(5000); polBalance = await provider.getBalance(userAddress); if (polBalance >= minRequiredPol) { confirmed = true; break; } } if (!confirmed) { await logPendingSweep(userId, userAddress, amountUSDT, 'POL_NOT_CONFIRMED_30s', txHashReceived); return { success: false, reason: 'POL_NOT_CONFIRMED' }; } }
        const { wallet } = paymentService.getWalletForUser(userId);
        const walletConnected = wallet.connect(provider);
        const usdtFromUser = usdtContract.connect(walletConnected);
        const amountWei = ethers.parseUnits(amountUSDT.toString(), 6);
        const tx = await usdtFromUser.transfer(process.env.OWNER_WALLET, amountWei);
        const receipt = await waitWithTimeout(tx, 180000);
        await safeSupabase(supabase.from('transactions').insert({ user_id: userId, type: 'sweep', amount: amountUSDT, status: 'completed', tx_hash: receipt.hash, address: process.env.OWNER_WALLET, created_at: new Date().toISOString() }), 'INSERT_SWEEP_TX');
        return { success: true, txHash: receipt.hash };
    } catch (e) { await logPendingSweep(userId, userAddress, amountUSDT, e.message, txHashReceived); return { success: false, reason: e.message }; }
}

// ═══ Background Intervals ═══
setInterval(processPendingRefunds, 60 * 1000);
setInterval(processPendingPayouts, 60 * 1000);
setInterval(processPendingSweeps, 2 * 60 * 1000);
setInterval(monitorOwnerPol, 60 * 60 * 1000);
setInterval(monitorPolEnhanced, 5 * 60 * 1000);
setInterval(recoverPendingBets, 5 * 60 * 1000);
setInterval(async () => { try { const { data: fraudCheck } = await supabase.rpc('check_fraud_players', { p_hours: FRAUD_CHECK_HOURS, p_min_bets: FRAUD_MIN_BETS, p_win_rate_threshold: FRAUD_WIN_RATE_THRESHOLD }); if (fraudCheck?.suspicious?.length > 0) { for (const player of fraudCheck.suspicious) { await supabase.from('users').update({ is_flagged: true, flag_reason: `High win rate: ${player.win_rate}%`, flagged_at: new Date().toISOString() }).eq('user_id', player.user_id); if (typeof io !== 'undefined' && io) io.to('admin_room').emit('fraud_alert', { userId: player.user_id, winRate: player.win_rate, totalBets: player.total_bets, totalWon: player.total_won, timestamp: new Date().toISOString() }); } } } catch (fraudErr) { logCritical('❌ fraud check:', fraudErr.message); } }, 60 * 60 * 1000);
setInterval(() => { const now = Date.now(); const MAX_AGE_MS = 24 * 60 * 60 * 1000; for (const [ip, userIds] of ipToUserIds) { if (userIds.size === 0) ipToUserIds.delete(ip); } for (const [userId, history] of colorSelectionHistory) { const filtered = history.filter(h => now - h.timestamp < MAX_AGE_MS); if (filtered.length === 0) colorSelectionHistory.delete(userId); else colorSelectionHistory.set(userId, filtered); } }, 60 * 60 * 1000);
setInterval(() => { const today = new Date().toISOString().slice(0, 10); if (dailyLossTracker.date !== today) { dailyLossTracker = { date: today, totalLoss: 0, totalWin: 0, roundsCount: 0 }; logCritical(`🌅 Daily trackers reset`); } }, 60 * 60 * 1000);

// ═════════════════════════════════════════════════════════════════
// 🎮 Game Loop
// ═════════════════════════════════════════════════════════════════
async function gameLoop() {
    let backoffMs = 2000, consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 50;
    while (true) {
        try {
            const playCheck = canPlayMore();
            if (!playCheck.allowed) { gamePhase = 'stopped'; if (typeof io !== 'undefined' && io) io.emit('game_stopped', { reason: playCheck.reason, message: MESSAGES.GAME.GAME_STOPPED }); await sleep(10000); continue; }
            if (!UI_CONFIG.features.pseudoRandomMode || !UI_CONFIG.features.pseudoRandomConfig || UI_CONFIG.features.pseudoRandomConfig.enabled === false) { UI_CONFIG.features.pseudoRandomMode = true; if (!UI_CONFIG.features.pseudoRandomConfig) UI_CONFIG.features.pseudoRandomConfig = {}; UI_CONFIG.features.pseudoRandomConfig.enabled = true; }
            gamePhase = 'waiting'; currentMultiplier = 1.00; countdownEndsAt = Date.now() + WAITING_DURATION_MS; currentChartPoints = [{ x: 0, y: 1.0 }]; activePlayers.clear(); _lastPlayersHash = '';
            const roundId = crypto.randomUUID();
            let fairData = null;
            try { fairData = await provablyFair.getServerSeedForRound(supabase); } catch (e) { logCritical('❌ getServerSeedForRound failed:', e.stack || e.message); recordCriticalError('getServerSeedForRound: ' + e.message); throw new Error('SEED_FETCH_FAILED: ' + e.message); }
            if (!fairData || typeof fairData !== 'object' || !fairData.serverSeed || typeof fairData.serverSeed !== 'string') { logCritical('❌ gameLoop: invalid fairData:', JSON.stringify(fairData)); throw new Error('INVALID_ROUND_SEED'); }
            if (!fairData.serverSeedHash || typeof fairData.serverSeedHash !== 'string') { logCritical('❌ gameLoop: invalid serverSeedHash:', JSON.stringify(fairData)); throw new Error('INVALID_ROUND_SEED_HASH'); }
            const roundSeed = fairData.serverSeed, roundSeedHash = fairData.serverSeedHash, nonce = fairData.index, baseClientSeed = 'polo-game-v8.3';
            let fairCp; try { fairCp = provablyFair.computeCrashPoint(roundSeed, baseClientSeed); } catch (e) { logCritical('❌ computeCrashPoint failed:', e.stack || e.message); throw e; }
            let prmResult; try { prmResult = await pickPseudoRandomCrashPoint(fairCp, roundSeed, baseClientSeed, nonce); } catch (e) { logCritical('❌ pickPseudoRandomCrashPoint failed:', e.stack || e.message); prmResult = { crashPoint: fairCp, clientSeed: baseClientSeed, isDirected: false }; }
            const crashPoint = prmResult.crashPoint, finalClientSeed = prmResult.clientSeed;
            currentRound = { round_id: roundId, crash_point: crashPoint, round_seed: roundSeed, client_seed: finalClientSeed, nonce, server_seed_hash: roundSeedHash, started_at: new Date().toISOString(), owner_commission_amount: 0, isDirectedRound: prmResult.isDirected };
            for (const [, bet] of roundBets) { if (bet.roundId === 'NEXT') bet.roundId = roundId; }
            await safeSupabase(supabase.from('rounds').insert(currentRound), 'INSERT_ROUND');
            if (typeof io !== 'undefined' && io) io.emit('game_waiting', { roundId, serverSeedHash: roundSeedHash, countdownEndsAt, duration: WAITING_DURATION_MS, history: recentHistory.map(h => h.crashPoint).slice(-10), colorBets: COLOR_BETS, trenballBets: TRENBALL_BETS, winConditions: WIN_CONDITIONS, verificationAvailable: true });
            await sleep(WAITING_DURATION_MS);
            gamePhase = 'running';
            const startedAt = Date.now();
            if (typeof io !== 'undefined' && io) io.emit('game_start', { roundId, serverSeedHash: roundSeedHash, startedAt, growthRate: GROWTH_RATE, currentMultiplier: 1.00 });
            broadcastPlayers(true);
            if (crashPoint === 1.00) { gamePhase = 'crashed'; await sleep(500); await crashRound(crashPoint, roundId, nonce, roundSeed, finalClientSeed); }
            else {
                await new Promise((resolve) => {
                    const tickInterval = setInterval(async () => {
                        try { const elapsed = (Date.now() - startedAt) / 1000.0; const multiplier = Math.max(1.00, Math.exp(GROWTH_RATE * elapsed)); currentMultiplier = multiplier; if (multiplier >= crashPoint) { clearInterval(tickInterval); gamePhase = 'crashed'; currentMultiplier = crashPoint; await crashRound(crashPoint, roundId, nonce, roundSeed, finalClientSeed); resolve(); } else { if (typeof io !== 'undefined' && io) io.volatile.emit('tick', { m: parseFloat(multiplier.toFixed(2)) }); } } catch (tickErr) { logCritical('❌ tick error:', tickErr.stack || tickErr.message); clearInterval(tickInterval); resolve(); }
                    }, TICK_INTERVAL_MS);
                });
            }
            await sleep(CRASH_DURATION_MS);
            currentRound = null; activePlayers.clear(); broadcastPlayers(true); backoffMs = 2000; consecutiveFailures = 0;
        } catch (loopErr) {
            consecutiveFailures++; logCritical('❌ gameLoop:', loopErr.stack || loopErr.message); gamePhase = 'waiting'; await sleep(backoffMs); backoffMs = Math.min(backoffMs * 2, 30000);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { logCritical('💥 Too many consecutive gameLoop failures — exiting'); process.exit(1); }
        }
    }
}

// ═════════════════════════════════════════════════════════════════
// 💥 Crash Round
// ═════════════════════════════════════════════════════════════════
async function crashRound(crashPoint, roundId, nonce, roundSeed, finalClientSeed) {
    const { data: claimed, error: claimErr } = await supabase.rpc('claim_round', { p_round_id: roundId });
    if (claimErr) { logCritical('❌ claim_round error:', claimErr.message); recordCriticalError('claim_round: ' + claimErr.message); return; }
    if (!claimed) { logCritical(`⚠️ Round ${roundId} already claimed — skipping`); return; }

    gamePhase = 'crashed'; currentMultiplier = crashPoint;
    recentHistory.unshift({ crashPoint, timestamp: Date.now() }); if (recentHistory.length > MAX_HISTORY) recentHistory.pop();
    if (typeof io !== 'undefined' && io) io.emit('game_crash', { crashPoint });
    let totalRealPool = 0; const allSlots = [];
    for (const [playerSocketId, player] of activePlayers) { if (!player.slots) continue; for (const slotData of player.slots) { if (slotData.roundId !== roundId) continue; allSlots.push({ socketId: playerSocketId, slot: slotData }); if (!slotData.isDemo) totalRealPool += slotData.originalAmount; } }
    const results = [];
    for (const { socketId, slot: slotData } of allSlots) {
        try { let won = false, targetMultiplier = 0, grossPayout = 0, alreadyPaid = false; if (slotData.type === 'COLOR' && slotData.color) { targetMultiplier = COLOR_BETS[slotData.color]?.multiplier || 0; won = evaluateColorWin(slotData.color, crashPoint); if (won && targetMultiplier > 0) grossPayout = slotData.originalAmount * targetMultiplier; } else if (slotData.type === 'TRENBALL' && slotData.trenballColor) { targetMultiplier = TRENBALL_BETS[slotData.trenballColor]?.multiplier || 0; won = evaluateColorWin(slotData.trenballColor, crashPoint); if (won && targetMultiplier > 0) grossPayout = slotData.originalAmount * targetMultiplier; } else if (slotData.type === 'CLASSIC') { if (slotData.cashedOut && slotData.paidOut && slotData.cashOutMultiplier) { won = true; targetMultiplier = slotData.cashOutMultiplier; grossPayout = slotData.originalAmount * targetMultiplier; alreadyPaid = true; } } results.push({ socketId, slotData, won, targetMultiplier, grossPayout, isDemo: slotData.isDemo, alreadyPaid }); }
        catch (err) { results.push({ socketId, slotData, won: false, targetMultiplier: 0, grossPayout: 0, isDemo: slotData.isDemo, alreadyPaid: false }); }
    }
    let actualRealPaid = 0;
    try { const { data: paidBets } = await supabase.from('bets').select('payout').eq('round_id', roundId).gt('payout', 0); if (paidBets) for (const b of paidBets) actualRealPaid += parseFloat(b.payout || 0); } catch (e) {}
    const betsToInsert = [];
    for (const r of results) {
        try {
            const { socketId, slotData } = r;
            const betTypeLabel = slotData.type === 'COLOR' ? `COLOR_${(slotData.color || '').toUpperCase()}` : (slotData.type === 'TRENBALL' && slotData.trenballColor) ? `TRENBALL_${slotData.trenballColor.toUpperCase()}` : (slotData.type || 'CLASSIC');
            if (r.won && r.isDemo) { const freshUser = await getUser(slotData.userId); if (!freshUser) continue; const newDemo = parseFloat(freshUser.demo_balance || 0) + r.grossPayout; try { await supabase.from('users').update({ demo_balance: newDemo }).eq('user_id', slotData.userId); if (typeof io !== 'undefined' && io) io.to(socketId).emit('bet_result', { betId: slotData.betId, slot: slotData.slotId, won: true, winAmount: r.grossPayout, profit: r.grossPayout - slotData.originalAmount, originalAmount: slotData.originalAmount, payoutMultiplier: r.targetMultiplier, newBalance: parseFloat(freshUser.balance || 0), newDemoBalance: newDemo, isDemo: true, crashPoint }); } catch (e) {} continue; }
            if (r.won && !r.isDemo && r.alreadyPaid) { await safeSupabase(supabase.from('bets').update({ crash_point: crashPoint }).eq('bet_id', slotData.betId), 'UPDATE_CASHOUT'); const freshUser = await getUser(slotData.userId); if (typeof io !== 'undefined' && io) io.to(socketId).emit('bet_result', { betId: slotData.betId, slot: slotData.slotId, won: true, winAmount: r.grossPayout, profit: r.grossPayout - slotData.originalAmount, originalAmount: slotData.originalAmount, payoutMultiplier: r.targetMultiplier, isCashOut: true, newBalance: parseFloat(freshUser?.balance || 0), newDemoBalance: parseFloat(freshUser?.demo_balance || 0), isDemo: false, crashPoint }); continue; }
            if (r.won && !r.isDemo) { const freshUser = await getUser(slotData.userId); if (!freshUser) { await safeSupabase(supabase.from('pending_payouts').insert({ user_id: slotData.userId, round_id: roundId, bet_id: slotData.betId, amount: r.grossPayout, reason: 'USER_NOT_FOUND', processed: false, created_at: new Date().toISOString() }), 'LOG_PENDING_PAYOUT'); continue; } const credit = await atomicCreditBalance(slotData.userId, r.grossPayout); if (!credit.success) { await safeSupabase(supabase.from('pending_payouts').insert({ user_id: slotData.userId, round_id: roundId, bet_id: slotData.betId, amount: r.grossPayout, reason: 'CREDIT_FAILED:' + credit.reason, processed: false, created_at: new Date().toISOString() }), 'LOG_PENDING_PAYOUT'); continue; } actualRealPaid += r.grossPayout; betsToInsert.push({ bet_id: slotData.betId, user_id: slotData.userId, round_id: roundId, bet_type: betTypeLabel, amount: slotData.originalAmount, payout: r.grossPayout, won: true, crash_point: crashPoint }); await safeSupabase(supabase.from('users').update({ total_won: parseFloat(freshUser.total_won || 0) + r.grossPayout }).eq('user_id', slotData.userId), 'UPDATE_TOTAL_WON'); if (typeof io !== 'undefined' && io) io.to(socketId).emit('bet_result', { betId: slotData.betId, slot: slotData.slotId, won: true, winAmount: r.grossPayout, profit: r.grossPayout - slotData.originalAmount, originalAmount: slotData.originalAmount, payoutMultiplier: r.targetMultiplier, newBalance: credit.newBalance, newDemoBalance: parseFloat(freshUser.demo_balance || 0), isDemo: false, crashPoint }); continue; }
            if (!r.won && r.isDemo) { const freshUser = await getUser(slotData.userId); if (typeof io !== 'undefined' && io) io.to(socketId).emit('bet_result', { betId: slotData.betId, slot: slotData.slotId, won: false, newBalance: parseFloat(freshUser?.balance || 0), newDemoBalance: parseFloat(freshUser?.demo_balance || 0), isDemo: true, crashPoint }); continue; }
            if (!r.won && !r.isDemo) { betsToInsert.push({ bet_id: slotData.betId, user_id: slotData.userId, round_id: roundId, bet_type: betTypeLabel, amount: slotData.originalAmount, payout: 0, won: false, crash_point: crashPoint }); const freshUser = await getUser(slotData.userId); if (typeof io !== 'undefined' && io) io.to(socketId).emit('bet_result', { betId: slotData.betId, slot: slotData.slotId, won: false, newBalance: parseFloat(freshUser?.balance || 0), newDemoBalance: parseFloat(freshUser?.demo_balance || 0), isDemo: false, crashPoint }); }
        } catch (err) {}
    }
    const ownerResult = await applyOwnerProfit(roundId, totalRealPool, actualRealPaid);
    if (betsToInsert.length > 0) await safeSupabase(supabase.from('bets').upsert(betsToInsert, { onConflict: 'bet_id', ignoreDuplicates: false }), 'BULK_UPSERT_BETS');
    const unclaimedResult = await processUnclaimedBets(roundId, crashPoint);
    if (unclaimedResult.processed > 0) logCritical(`🔄 [CRASH] Processed ${unclaimedResult.processed} unclaimed bets`);
    await safeSupabase(supabase.from('rounds').update({ owner_commission_amount: ownerResult.ownerCommission, total_pool: totalRealPool, total_paid: actualRealPaid, ended_at: new Date().toISOString() }).eq('round_id', roundId), 'UPDATE_ROUND_END');
    for (const [k, v] of roundBets) { if (v.roundId === roundId) roundBets.delete(k); }
    if (typeof io !== 'undefined' && io) io.emit('round_ended', { roundId, crashPoint, serverSeedHash: currentRound?.server_seed_hash, totalPool: totalRealPool, totalPaid: actualRealPaid, ownerGain: ownerResult.ownerGain, ownerCommission: ownerResult.ownerCommission, deficit: ownerResult.deficitAmount, surplus: ownerResult.surplusAmount, serverSeed: roundSeed, clientSeed: finalClientSeed, verification: { available: true, serverSeed: roundSeed, clientSeed: finalClientSeed, nonce, serverSeedHash: currentRound?.server_seed_hash } });
}

// ═════════════════════════════════════════════════════════════════
// 💳 Deposit Listener
// ═════════════════════════════════════════════════════════════════
async function startDepositListener() {
    const addressToUserId = new Map();
    async function refreshAddressCache() { try { const { data: users } = await supabase.from('users').select('user_id, deposit_address').not('deposit_address', 'is', null); if (users) { addressToUserId.clear(); for (const u of users) if (u.deposit_address) addressToUserId.set(u.deposit_address.toLowerCase(), u.user_id); } } catch (e) {} }
    await refreshAddressCache();
    setInterval(refreshAddressCache, 5 * 60 * 1000);
    const setupListener = () => {
        try {
            usdtContract.removeAllListeners("Transfer");
            usdtContract.on("Transfer", async (sender, recipient, rawAmount, event) => {
                try {
                    const recipientLower = recipient.toLowerCase();
                    const userId = addressToUserId.get(recipientLower);
                    if (!userId) return;
                    const grossAmount = parseFloat(ethers.formatUnits(rawAmount, 6));
                    if (grossAmount <= 0) return;
                    const txHash = event.log.transactionHash;
                    const { data: existingTx } = await supabase.from('transactions').select('id').eq('tx_hash', txHash).maybeSingle();
                    if (existingTx) return;
                    if (grossAmount < MIN_DEPOSIT) { await safeSupabase(supabase.from('transactions').insert({ user_id: userId, type: 'deposit', amount: grossAmount, fee: 0, gross_amount: grossAmount, status: 'below_min', tx_hash: txHash, address: recipientLower }), 'INSERT_BELOW_MIN'); return; }
                    const user = await getUser(userId);
                    if (!user) return;
                    const _gsD = UI_CONFIG.gameSettings || {};
                    const _depositPct = parseFloat(_gsD.depositFeePercent ?? _gsD.depositFee ?? 0.01) || 0;
                    const _depositFixed = parseFloat(_gsD.depositFeeFixed) || 0;
                    const _sweepPct = parseFloat(_gsD.sweepFeePercent ?? _gsD.sweepFee ?? 0) || 0;
                    const depositFee = Math.min((grossAmount * _depositPct) + _depositFixed, grossAmount * 0.2);
                    const sweepFee = Math.min(grossAmount * _sweepPct, grossAmount * 0.05);
                    const netAmount = Math.max(0, grossAmount - depositFee - sweepFee);
                    const credit = await atomicCreditBalance(userId, netAmount);
                    if (!credit.success) return;
                    await safeSupabase(supabase.from('transactions').insert({ user_id: userId, type: 'deposit', amount: netAmount, fee: depositFee, sweep_fee: sweepFee, gross_amount: grossAmount, status: 'completed', tx_hash: txHash, address: recipientLower }), 'INSERT_DEPOSIT');
                    await supabase.from('users').update({ total_deposited: parseFloat(user.total_deposited || 0) + netAmount, updated_at: new Date().toISOString() }).eq('user_id', userId);
                    if (typeof io !== 'undefined' && io) io.to(`user_${userId}`).emit('deposit_confirmed', { amount: netAmount, grossAmount, depositFee, sweepFee, totalFees: depositFee + sweepFee, newBalance: credit.newBalance, txId: txHash, message: '✅ تم تأكيد إيداعك' });
                    await sweepToAdmin(userId, recipientLower, grossAmount, txHash);
                } catch (innerErr) { logCritical('❌ Deposit handler:', innerErr.message); }
            });
        } catch (e) {}
    };
    setupListener();
    setInterval(setupListener, 5 * 60 * 1000);
}

// ═════════════════════════════════════════════════════════════════
// 🔌 Socket.IO Server
// ═════════════════════════════════════════════════════════════════
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : (process.env.NODE_ENV === 'production' ? false : true), methods: ['GET', 'POST'], credentials: true }, pingTimeout: 60000, pingInterval: 25000, transports: ['websocket', 'polling'], maxHttpBufferSize: 1e4, perMessageDeflate: false });

const adminSocketAuthAttempts = new Map();
const ADMIN_SOCKET_MAX_ATTEMPTS = 10;
const ADMIN_SOCKET_WINDOW_MS = 15 * 60 * 1000;
function checkAdminSocketRateLimit(ip) { const now = Date.now(); const entry = adminSocketAuthAttempts.get(ip); if (!entry || now > entry.resetAt) { adminSocketAuthAttempts.set(ip, { count: 1, resetAt: now + ADMIN_SOCKET_WINDOW_MS }); return true; } if (entry.count >= ADMIN_SOCKET_MAX_ATTEMPTS) return false; entry.count++; return true; }
setInterval(() => { const now = Date.now(); for (const [ip, entry] of adminSocketAuthAttempts) { if (now > entry.resetAt) adminSocketAuthAttempts.delete(ip); } }, 60 * 1000);

function getClientIp(socket) { const xff = socket.handshake.headers['x-forwarded-for']; if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim(); return socket.handshake.address; }

io.use((socket, next) => { const auth = socket.handshake.auth || {}; const result = verifyIntegrityHeaders(auth); if (!result.ok) return next(new Error(result.code)); socket.isVerifiedApp = true; next(); });

io.on('connection', (socket) => {
    socket.emit('config_snapshot', { version: UI_CONFIG.version, config: getPublicConfig() });
    socket.on('request_game_state', () => { try { socket.emit('game_state', { phase: gamePhase, multiplier: currentMultiplier, chartPoints: currentChartPoints.slice(-5), history: recentHistory.map(h => h.crashPoint).slice(-10), players: getCurrentPlayersPayload() }); } catch (e) {} });
    socket.on('request_round_history', async () => { try { const { data } = await supabase.from('rounds').select('round_id, crash_point, round_seed, server_seed_hash, client_seed, nonce, ended_at').not('ended_at', 'is', null).order('ended_at', { ascending: false }).limit(20); if (data) socket.emit('round_history_data', { rounds: data.map(r => ({ roundId: r.round_id, crashPoint: parseFloat(r.crash_point), serverSeed: r.round_seed, serverSeedHash: r.server_seed_hash, clientSeed: r.client_seed, nonce: r.nonce, timestamp: r.ended_at })) }); } catch (e) { logCritical('❌ request_round_history:', e.message); } });
    socket.on('sync_balance', async () => { if (!socket.userId) return; try { const user = await getUser(socket.userId); if (user) socket.emit('balance_update', { balance: parseFloat(user.balance || 0), demoBalance: parseFloat(user.demo_balance || 0) }); } catch (e) {} });

    socket.on('admin_auth', (data) => { const clientIp = getClientIp(socket); if (!checkAdminSocketRateLimit(clientIp)) { socket.disconnect(true); return; } socket.adminAuthAttempts = (socket.adminAuthAttempts || 0) + 1; if (socket.adminAuthAttempts > 5) { socket.disconnect(true); return; } const token = data?.token; if (!token || typeof token !== 'string') return socket.emit('admin_auth_error', { code: 'MISSING_TOKEN' }); const jwtPayload = verifyAdminToken(token); if (jwtPayload) { socket.join('admin_room'); socket.isAdmin = true; socket.adminEmail = jwtPayload.email; socket.adminAuthAttempts = 0; socket.emit('admin_authenticated', { success: true, via: 'jwt' }); return; } const expected = process.env.ADMIN_TOKEN || ''; if (expected.length > 0 && timingSafeEqualStr(String(token), expected)) { socket.join('admin_room'); socket.isAdmin = true; socket.adminAuthAttempts = 0; socket.emit('admin_authenticated', { success: true, via: 'legacy' }); return; } socket.emit('admin_auth_error', { code: 'INVALID_ADMIN_TOKEN' }); });

    socket.on('authenticate', async (data) => {
        try {
            const token = data?.token;
            if (!token || typeof token !== 'string') return socket.emit('auth_error', { code: 'MISSING_TOKEN', message: MESSAGES.AUTH.MISSING_TOKEN });
            let userId;
            try { const payload = jwt.verify(token, JWT_SIGN_SECRET, { algorithms: ['HS256'], issuer: 'polo-game', audience: 'player' }); if (payload.type !== 'session' || !payload.userId) return socket.emit('auth_error', { code: 'INVALID_TOKEN_TYPE', message: MESSAGES.AUTH.INVALID_TOKEN_TYPE }); userId = payload.userId; } catch (jwtErr) { return socket.emit('auth_error', { code: 'INVALID_TOKEN', message: MESSAGES.AUTH.INVALID_TOKEN }); }
            const user = await getUser(userId);
            if (!user) return socket.emit('auth_error', { code: 'USER_NOT_FOUND', message: MESSAGES.AUTH.INVALID_TOKEN });
            if (user.is_banned || user.is_frozen) return socket.emit('auth_error', { code: 'USER_RESTRICTED', message: MESSAGES.AUTH.USER_RESTRICTED });
            const clientIp = getClientIp(socket);
            const deviceFp = data?.deviceFingerprint || socket.handshake.auth?.['x-device-fingerprint'];
            if (clientIp) recordIP(userId, clientIp);
            if (deviceFp) recordDevice(userId, deviceFp);
            const multiAccountCheck = checkMultiAccount(userId, clientIp, deviceFp);
            if (multiAccountCheck.suspicious) { logCritical(`⚠️ [MULTI-ACCOUNT] userId=${userId} reason=${multiAccountCheck.reason}`); if (!user.is_flagged) { try { await supabase.from('users').update({ is_flagged: true, flag_reason: `Multi-account: ${multiAccountCheck.reason}`, flagged_at: new Date().toISOString() }).eq('user_id', userId); } catch (e) {} } if (typeof io !== 'undefined' && io) io.to('admin_room').emit('multi_account_alert', { userId, reason: multiAccountCheck.reason, sharedWith: multiAccountCheck.sharedWith, ip: clientIp, deviceFp, timestamp: new Date().toISOString() }); }
            socket.userId = userId; socket.username = user.username || `Player_${userId.slice(-4)}`; socket.clientIp = clientIp; socket.deviceFp = deviceFp; socket.join(`user_${userId}`);
            let depositAddress = user.deposit_address;
            if (!depositAddress) { try { depositAddress = paymentService.tryGetDepositAddress(userId); } catch (e) {} if (depositAddress) await supabase.from('users').update({ deposit_address: depositAddress }).eq('user_id', userId); }
            socket.emit('authenticated', { userId: user.user_id, username: socket.username, balance: parseFloat(user.balance || 0), demoBalance: parseFloat(user.demo_balance ?? DEMO_BALANCE), depositAddress: depositAddress || null, minWithdrawal: MIN_WITHDRAWAL, maxWithdrawal: MAX_WITHDRAWAL, withdrawalFeeFixed: WITHDRAWAL_FEE_FIXED, depositFee: DEPOSIT_FEE, depositFeeFixed: DEPOSIT_FEE_FIXED, sweepFee: SWEEP_FEE, minDeposit: MIN_DEPOSIT, colorBets: COLOR_BETS, trenballBets: TRENBALL_BETS, winConditions: WIN_CONDITIONS, maxSlotsPerPlayer: MAX_SLOTS_PER_PLAYER, totalDeposited: parseFloat(user.total_deposited || 0), totalWithdrawn: parseFloat(user.total_withdrawn || 0), withdrawable: parseFloat(user.balance || 0), isFlagged: user.is_flagged === true });
            const reconnect = trackPlayerReconnect(userId, socket.id);
            if (reconnect.reconnected && reconnect.canCashOut) socket.emit('welcome_back', { message: MESSAGES.GAME.WELCOME_BACK, disconnectedFor: Math.round(reconnect.duration / 1000), canCashOut: true });
            setTimeout(() => { try { socket.emit('game_state', { phase: gamePhase, multiplier: currentMultiplier, chartPoints: currentChartPoints.slice(-5), history: recentHistory.map(h => h.crashPoint).slice(-10), players: getCurrentPlayersPayload() }); } catch (e) {} }, 300);
        } catch (e) { logCritical('❌ socket authenticate:', e.stack || e.message); socket.emit('auth_error', { code: 'AUTH_FAILED', message: MESSAGES.AUTH.AUTH_FAILED }); }
    });

    socket.on('place_bet', async (data) => {
        if (!socket.isVerifiedApp) return socket.emit('bet_error', { code: 'APP_NOT_VERIFIED', message: 'يرجى استخدام التطبيق الرسمي' });
        if (!socket.userId) return socket.emit('bet_error', { code: 'NOT_AUTHENTICATED', message: MESSAGES.BET.NOT_AUTHENTICATED });
        const playCheck = canPlayMore(); if (!playCheck.allowed) return socket.emit('bet_error', { code: 'GAME_SUSPENDED', message: MESSAGES.BET.GAME_SUSPENDED });
        const { error: vErr, value: vData } = validate('placeBet', data);
        if (vErr) return socket.emit('bet_error', { code: 'INVALID_INPUT', message: MESSAGES.BET.INVALID_INPUT, details: Array.isArray(vErr) ? vErr.map(e => e.message) : [vErr.message] });
        data = vData;
        if (UI_CONFIG.features?.enableBotProtection !== false) { const botCheck = socketRateLimiter.check(socket.userId); if (!botCheck.allowed) return socket.emit('bet_error', { code: botCheck.reason, message: MESSAGES.BET.RATE_LIMITED, waitMs: botCheck.waitMs, blockedUntil: botCheck.blockedUntil }); }
        const lockResult = await userLock.run(socket.userId, async () => {
            if (UI_CONFIG.features && UI_CONFIG.features.enableGameEngine === false) return socket.emit('bet_error', { code: 'GAME_STOPPED_BY_ADMIN', message: MESSAGES.BET.GAME_SUSPENDED });
            const { betId, betType, amount, useDemo, color, trenballColor, autoCashOut } = data || {};
            if (!currentRound || gamePhase !== 'waiting') return socket.emit('bet_error', { code: 'BETTING_CLOSED', message: MESSAGES.GAME.BETTING_CLOSED });
            if (!betId || typeof betId !== 'string' || betId.length < 8 || betId.length > 100) return socket.emit('bet_error', { code: 'INVALID_BET_ID', message: MESSAGES.BET.INVALID_BET_ID });
            if (isBetAlreadyProcessed(betId)) return socket.emit('bet_error', { code: 'DUPLICATE_BET_ID', message: MESSAGES.BET.DUPLICATE_BET_ID });
            if (!socket.processedBetIds) socket.processedBetIds = new Set();
            if (socket.processedBetIds.size > 200) { const arr = [...socket.processedBetIds]; socket.processedBetIds = new Set(arr.slice(-100)); }
            if (socket.processedBetIds.has(betId)) return socket.emit('bet_error', { code: 'DUPLICATE_BET_ID', message: MESSAGES.BET.DUPLICATE_BET_ID });
            if (color && trenballColor) return socket.emit('bet_error', { code: 'INVALID_BET_MIX', message: MESSAGES.BET.INVALID_BET_MIX });
            if (betType === 'CLASSIC' && (color || trenballColor)) return socket.emit('bet_error', { code: 'INVALID_BET_TYPE_MIX', message: MESSAGES.BET.INVALID_BET_TYPE_MIX });
            let type = betType || 'CLASSIC', slotId = 'classic', colorConfig = null, trenballConfig = null;
            if (color && COLOR_BETS[color]) { type = 'COLOR'; slotId = `color_${color}`; colorConfig = COLOR_BETS[color]; }
            else if (trenballColor && TRENBALL_BETS[trenballColor]) { type = 'TRENBALL'; slotId = `trenball_${trenballColor}`; trenballConfig = TRENBALL_BETS[trenballColor]; }
            else if (type !== 'CLASSIC') return socket.emit('bet_error', { code: 'INVALID_BET_TYPE', message: MESSAGES.BET.INVALID_BET_TYPE });
            let userTotalSlots = 0; for (const [, p] of activePlayers) { if (p.userId === socket.userId && p.slots) userTotalSlots += p.slots.length; }
            if (userTotalSlots >= MAX_SLOTS_PER_PLAYER) return socket.emit('bet_error', { code: 'MAX_SLOTS_REACHED', message: MESSAGES.BET.MAX_SLOTS_REACHED, max: MAX_SLOTS_PER_PLAYER });
            for (const [, p] of activePlayers) { if (p.userId === socket.userId && p.slots?.some(s => s.slotId === slotId && s.roundId === currentRound.round_id)) return socket.emit('bet_error', { code: 'SLOT_ALREADY_USED', message: MESSAGES.BET.SLOT_ALREADY_USED, slot: slotId }); }
            const numericAmount = parseFloat(amount);
            if (isNaN(numericAmount) || numericAmount <= 0 || numericAmount < MIN_BET || numericAmount > MAX_BET) return socket.emit('bet_error', { code: 'INVALID_AMOUNT', message: MESSAGES.BET.INVALID_AMOUNT, min: MIN_BET, max: MAX_BET });
            const now = Date.now();
            if (!socket.lastBetTime) socket.lastBetTime = 0;
            if (now - socket.lastBetTime < MIN_MS_BETWEEN_BETS) return socket.emit('bet_error', { code: 'RATE_LIMITED', message: MESSAGES.BET.RATE_LIMITED, waitMs: MIN_MS_BETWEEN_BETS });
            socket.lastBetTime = now;
            if (type === 'COLOR' && color) recordColorChoice(socket.userId, color);
            if (type === 'TRENBALL' && trenballColor) recordColorChoice(socket.userId, trenballColor);
            try {
                const user = await getUser(socket.userId);
                if (!user) return socket.emit('bet_error', { code: 'USER_NOT_FOUND', message: MESSAGES.BET.USER_NOT_FOUND });
                if (user.is_flagged === true) return socket.emit('bet_error', { code: 'ACCOUNT_UNDER_REVIEW', message: MESSAGES.BET.ACCOUNT_UNDER_REVIEW });
                const real = parseFloat(user.balance || 0), demo = parseFloat(user.demo_balance || DEMO_BALANCE);
                const usingDemo = useDemo === true || (real < numericAmount && demo >= numericAmount);
                if (usingDemo && demo < numericAmount) return socket.emit('bet_error', { code: 'INSUFFICIENT_DEMO', message: MESSAGES.BET.INSUFFICIENT_DEMO });
                if (!usingDemo && real < numericAmount) return socket.emit('bet_error', { code: 'INSUFFICIENT_REAL', message: MESSAGES.BET.INSUFFICIENT_REAL });
                let deductionRollback = null, currentRealBalance = real;
                if (usingDemo) { const result = await updateUserDemoBalance(socket.userId, demo - numericAmount); if (!result) return socket.emit('bet_error', { code: 'DEDUCTION_FAILED', message: MESSAGES.BET.DEDUCTION_FAILED }); deductionRollback = async () => { try { await updateUserDemoBalance(socket.userId, demo); } catch (e) {} }; }
                else { const deductResult = await atomicDeductBalance(socket.userId, numericAmount); if (!deductResult.success) return socket.emit('bet_error', { code: deductResult.reason || 'INSUFFICIENT_BALANCE', message: deductResult.reason === 'INSUFFICIENT_BALANCE' ? MESSAGES.BET.INSUFFICIENT_REAL : MESSAGES.BET.DEDUCTION_FAILED }); currentRealBalance = deductResult.newBalance; deductionRollback = async () => { const credit = await atomicCreditBalance(socket.userId, numericAmount); if (!credit.success) await logRefund(socket.userId, numericAmount, 'ROLLBACK_FAILED', { betId }); }; }
                try {
                    const betTypeLabel = type === 'COLOR' ? `COLOR_${(color || '').toUpperCase()}` : (type === 'TRENBALL' && trenballColor) ? `TRENBALL_${trenballColor.toUpperCase()}` : 'CLASSIC';
                    const { error: dbBetError } = await supabase.from('bets').insert({ bet_id: betId, user_id: socket.userId, round_id: currentRound.round_id, bet_type: betTypeLabel, amount: numericAmount, payout: 0, won: false, crash_point: 0 });
                    if (dbBetError) { if (deductionRollback) await deductionRollback(); const isDuplicate = dbBetError.code === '23505' || (dbBetError.message || '').toLowerCase().includes('duplicate'); return socket.emit('bet_error', { code: isDuplicate ? 'ALREADY_BET_THIS_ROUND' : 'DB_INSERT_FAILED', message: isDuplicate ? MESSAGES.BET.ALREADY_BET_THIS_ROUND : MESSAGES.BET.DB_INSERT_FAILED }); }
                    const newSlot = { slotId, betId, userId: socket.userId, type, color: colorConfig ? color : null, colorMultiplier: colorConfig ? colorConfig.multiplier : null, colorLabel: colorConfig ? colorConfig.label : null, trenballColor: trenballConfig ? trenballColor : null, trenballMultiplier: trenballConfig ? trenballConfig.multiplier : null, trenballLabel: trenballConfig ? trenballConfig.label : null, originalAmount: numericAmount, amount: numericAmount, isDemo: usingDemo, cashedOut: false, paidOut: false, processing: false, cashOutMultiplier: null, roundId: currentRound.round_id, placedAt: now, autoCashOut: parseFloat(autoCashOut) || null };
                    if (!activePlayers.has(socket.id)) activePlayers.set(socket.id, { userId: socket.userId, name: socket.username, slots: [] });
                    activePlayers.get(socket.id).slots.push(newSlot); roundBets.set(`${socket.id}:${slotId}`, newSlot); socket.processedBetIds.add(betId); markBetAsProcessed(betId);
                    socket.emit('bet_placed', { betId, slot: slotId, color: colorConfig ? color : null, colorLabel: colorConfig ? colorConfig.label : null, colorMultiplier: colorConfig ? colorConfig.multiplier : null, trenballColor: trenballConfig ? trenballColor : null, trenballLabel: trenballConfig ? trenballConfig.label : null, trenballMultiplier: trenballConfig ? trenballConfig.multiplier : null, amount: numericAmount, newBalance: usingDemo ? real : currentRealBalance, newDemoBalance: usingDemo ? demo - numericAmount : demo, isDemo: usingDemo, message: MESSAGES.BET.BET_PLACED });
                    if (UI_CONFIG.features?.enableBotProtection !== false) { socketRateLimiter.record(socket.userId); behaviorTracker.record(socket.userId, numericAmount, betTypeLabel); const analysis = behaviorTracker.analyze(socket.userId); if (analysis.suspicious) { logCritical(`🤖 BOT: ${socket.userId} score=${analysis.score}`); io.to('admin_room').emit('bot_suspect_alert', { userId: socket.userId, score: analysis.score, reasons: analysis.reasons, timestamp: new Date().toISOString() }); try { await supabase.from('users').update({ is_flagged: true, flag_reason: `Bot suspected: ${analysis.reasons.join(',')} (score=${analysis.score})`, flagged_at: new Date().toISOString() }).eq('user_id', socket.userId); } catch (e) {} } }
                    broadcastPlayers(true);
                } catch (slotErr) { if (deductionRollback) await deductionRollback(); socket.emit('bet_error', { code: 'BET_CREATION_FAILED', message: MESSAGES.BET.BET_CREATION_FAILED }); }
            } catch (e) { socket.emit('bet_error', { code: 'SERVER_ERROR', message: MESSAGES.BET.SERVER_ERROR }); }
        });
        if (lockResult?.error === 'CONCURRENT_REQUEST') return socket.emit('bet_error', { code: 'CONCURRENT_REQUEST', message: MESSAGES.BET.CONCURRENT_REQUEST });
    });

    socket.on('query_bet_status', async (data) => { if (!socket.userId) return; const { betId } = data || {}; if (!betId) return; let found = null; for (const [, v] of roundBets) { if (v.betId === betId && v.userId === socket.userId) { found = v; break; } } if (!found) return socket.emit('bet_status_response', { betId, status: 'not_found' }); const user = await getUser(socket.userId); socket.emit('bet_status_response', { betId, status: found.cashedOut ? 'confirmed' : 'pending', balance: parseFloat(user?.balance || 0), demoBalance: parseFloat(user?.demo_balance || 0) }); });
    socket.on('cancel_bet', async (data) => { if (!socket.userId) return; if (gamePhase !== 'waiting' || !currentRound) return socket.emit('bet_error', { code: 'BETTING_CLOSED', message: MESSAGES.GAME.BETTING_CLOSED }); const cancelRoundId = currentRound.round_id; const { betId } = data || {}; const player = activePlayers.get(socket.id); if (!player?.slots) return socket.emit('bet_cancelled', { betId }); const slotsToCancel = betId ? player.slots.filter(s => s.betId === betId && s.userId === socket.userId && !s.cashedOut) : player.slots.filter(s => s.userId === socket.userId && !s.cashedOut); for (const slot of slotsToCancel) { try { if (gamePhase !== 'waiting' || !currentRound || currentRound.round_id !== cancelRoundId || slot.roundId !== cancelRoundId) return socket.emit('bet_error', { code: 'BETTING_CLOSED', message: MESSAGES.GAME.BETTING_CLOSED }); if (slot.isDemo) { const user = await getUser(socket.userId); if (user) await updateUserDemoBalance(socket.userId, parseFloat(user.demo_balance || 0) + slot.originalAmount); } else { const credit = await atomicCreditBalance(socket.userId, slot.originalAmount); if (!credit.success) await logRefund(socket.userId, slot.originalAmount, 'CANCEL_CREDIT_FAILED', { betId: slot.betId }); } await supabase.from('bets').delete().eq('bet_id', slot.betId); player.slots = player.slots.filter(s => s.betId !== slot.betId); roundBets.delete(`${socket.id}:${slot.slotId}`); socket.processedBetIds?.delete(slot.betId); } catch (e) {} } socket.emit('bet_cancelled', { betId, message: MESSAGES.GAME.BET_CANCELLED }); broadcastPlayers(true); });
    socket.on('cash_out', async (data) => {
        try {
            if (!socket.userId || !currentRound || gamePhase !== 'running') return;
            const checkUser = await getUser(socket.userId); if (checkUser?.is_flagged) return;
            const { slot } = data || {}; const player = activePlayers.get(socket.id); if (!player || !player.slots) return;
            const slotsToCash = slot ? player.slots.filter(s => s.slotId === slot && !s.cashedOut && s.type === 'CLASSIC' && s.userId === socket.userId) : player.slots.filter(s => !s.cashedOut && s.type === 'CLASSIC' && s.userId === socket.userId);
            if (currentMultiplier >= currentRound.crash_point) return; if (currentMultiplier <= 1.00) return;
            if (socket.lastCashoutTime && Date.now() - socket.lastCashoutTime < MIN_MS_BETWEEN_CASHOUTS) return;
            socket.lastCashoutTime = Date.now();
            for (const slotData of slotsToCash) {
                if (slotData.cashedOut || slotData.paidOut || slotData.processing) continue; if (slotData.userId !== socket.userId) continue;
                slotData.processing = true; slotData.cashedOut = true; slotData.cashOutMultiplier = currentMultiplier;
                const originalAmount = slotData.originalAmount, winAmount = originalAmount * currentMultiplier;
                try {
                    const freshUser = await getUser(slotData.userId); if (!freshUser) { slotData.processing = false; slotData.cashedOut = false; slotData.cashOutMultiplier = null; continue; }
                    const oldBalance = slotData.isDemo ? parseFloat(freshUser.demo_balance || 0) : parseFloat(freshUser.balance || 0);
                    let creditNewBalance = oldBalance + winAmount, updateSuccess = false;
                    if (slotData.isDemo) { const r = await updateUserDemoBalance(slotData.userId, oldBalance + winAmount); updateSuccess = !!r; }
                    else { const result = await cashoutAtomic(slotData.userId, slotData.betId, winAmount, currentMultiplier, currentMultiplier); if (result.success) { updateSuccess = true; creditNewBalance = result.newBalance; } }
                    if (!updateSuccess) { slotData.processing = false; slotData.cashedOut = false; slotData.cashOutMultiplier = null; socket.emit('bet_error', { code: 'CASHOUT_FAILED', message: MESSAGES.GAME.CASHOUT_FAILED }); continue; }
                    slotData.paidOut = true;
                    socket.emit('bet_result', { betId: slotData.betId, slot: slotData.slotId, won: true, winAmount, profit: winAmount - originalAmount, originalAmount, cashOutMultiplier: currentMultiplier, payoutMultiplier: currentMultiplier, isCashOut: true, newBalance: slotData.isDemo ? oldBalance : creditNewBalance, newDemoBalance: slotData.isDemo ? oldBalance + winAmount : parseFloat(freshUser.demo_balance || 0), isDemo: slotData.isDemo, message: MESSAGES.GAME.CASHOUT_SUCCESS });
                } catch (e) { logCritical('❌ cash_out exception:', e.message); slotData.processing = false; slotData.cashedOut = false; slotData.cashOutMultiplier = null; }
            }
            broadcastPlayers(true);
        } catch (e) {}
    });
    socket.on('request_withdrawal', async (data) => {
        const traceId = crypto.randomBytes(4).toString('hex');
        try {
            if (SAFE_MODE) return socket.emit('withdrawal_error', { code: 'SAFE_MODE_BLOCKED', message: MESSAGES.WITHDRAWAL.SAFE_MODE_BLOCKED, traceId });
            if (isCircuitTripped()) return socket.emit('withdrawal_error', { code: 'CIRCUIT_BREAKER', message: 'النظام متوقف مؤقتاً لأسباب أمنية', traceId });
            if (currentPolState.level === 'CRITICAL' || currentPolState.level === 'DANGER') { logCritical(`⚠️ [WITHDRAWAL] Low POL but allowing: user=${socket.userId}`); if (typeof io !== 'undefined' && io) io.to('admin_room').emit('withdrawal_with_low_pol', { userId: socket.userId, level: currentPolState.level, polBalance: currentPolState.balance, timestamp: new Date().toISOString() }); }
            const { error: vErr, value: vData } = validate('requestWithdrawal', data);
            if (vErr) return socket.emit('withdrawal_error', { code: 'INVALID_INPUT', message: MESSAGES.WITHDRAWAL.INVALID_ADDRESS_FORMAT, traceId, details: Array.isArray(vErr) ? vErr.map(e => e.message) : [vErr.message] });
            data = vData;
            const { address, amount } = data || {};
            if (!socket.userId) return socket.emit('withdrawal_error', { code: 'NOT_AUTHENTICATED', message: MESSAGES.WITHDRAWAL.NOT_AUTHENTICATED, traceId });
            if (!address || typeof address !== 'string' || !address.startsWith('0x') || address.length !== 42) return socket.emit('withdrawal_error', { code: 'INVALID_ADDRESS_FORMAT', message: MESSAGES.WITHDRAWAL.INVALID_ADDRESS_FORMAT, traceId });
            if (address.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return socket.emit('withdrawal_error', { code: 'INVALID_ADDRESS', message: MESSAGES.WITHDRAWAL.INVALID_ADDRESS, traceId });
            if (address.toLowerCase() === adminWallet.address.toLowerCase()) return socket.emit('withdrawal_error', { code: 'SELF_WITHDRAWAL', message: MESSAGES.WITHDRAWAL.SELF_WITHDRAWAL, traceId });
            const now = Date.now();
            const MIN_MS_BETWEEN_WITHDRAWALS = parseInt(process.env.MIN_MS_BETWEEN_WITHDRAWALS || '60000', 10);
            if (socket.lastWithdrawalTime && now - socket.lastWithdrawalTime < MIN_MS_BETWEEN_WITHDRAWALS) return socket.emit('withdrawal_error', { code: 'RATE_LIMITED', message: MESSAGES.WITHDRAWAL.RATE_LIMITED, traceId, waitMs: MIN_MS_BETWEEN_WITHDRAWALS - (now - socket.lastWithdrawalTime) });
            socket.lastWithdrawalTime = now;
            const requestedAmount = parseFloat(amount);
            if (isNaN(requestedAmount) || requestedAmount <= 0) return socket.emit('withdrawal_error', { code: 'INVALID_AMOUNT', message: MESSAGES.WITHDRAWAL.INVALID_AMOUNT, traceId });
            if (requestedAmount < MIN_WITHDRAWAL) return socket.emit('withdrawal_error', { code: 'BELOW_MIN_WITHDRAWAL', message: MESSAGES.WITHDRAWAL.BELOW_MIN_WITHDRAWAL, traceId, minWithdrawal: MIN_WITHDRAWAL });
            if (requestedAmount > MAX_WITHDRAWAL) return socket.emit('withdrawal_error', { code: 'ABOVE_MAX_WITHDRAWAL', message: MESSAGES.WITHDRAWAL.ABOVE_MAX_WITHDRAWAL, traceId, maxWithdrawal: MAX_WITHDRAWAL });
            const user = await getUser(socket.userId);
            if (!user) return socket.emit('withdrawal_error', { code: 'USER_NOT_FOUND', message: MESSAGES.WITHDRAWAL.USER_NOT_FOUND, traceId });
            if (user.is_banned === true || user.is_frozen === true) return socket.emit('withdrawal_error', { code: 'ACCOUNT_RESTRICTED', message: MESSAGES.WITHDRAWAL.ACCOUNT_RESTRICTED, traceId });
            if (user.is_flagged === true) return socket.emit('withdrawal_error', { code: 'ACCOUNT_UNDER_REVIEW', message: MESSAGES.WITHDRAWAL.ACCOUNT_UNDER_REVIEW, traceId });
            const withdrawalFee = calculateWithdrawalFee(requestedAmount);
            const totalDeduction = requestedAmount + withdrawalFee;
            const deductResult = await atomicDeductBalance(socket.userId, totalDeduction);
            if (!deductResult.success) return socket.emit('withdrawal_error', { code: deductResult.reason || 'INSUFFICIENT_BALANCE', message: deductResult.reason === 'INSUFFICIENT_BALANCE' ? MESSAGES.WITHDRAWAL.INSUFFICIENT_BALANCE : MESSAGES.WITHDRAWAL.SERVER_ERROR, traceId });
            const newBalance = deductResult.newBalance;
            const txHash = `wd_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
            const availableAt = new Date().toISOString();
            const { error: insertErr } = await safeSupabase(supabase.from('transactions').insert({ user_id: socket.userId, type: 'withdrawal', amount: requestedAmount, fee: withdrawalFee, total_amount: totalDeduction, address: address.trim(), status: 'pending', tx_hash: txHash, is_owner: user.is_owner === true, available_at: availableAt }), 'INSERT_WITHDRAWAL');
            if (insertErr) { const revert = await atomicCreditBalance(socket.userId, totalDeduction); if (!revert.success) await logRefund(socket.userId, totalDeduction, 'WITHDRAWAL_INSERT_FAILED', { txHash }); return socket.emit('withdrawal_error', { code: 'WITHDRAWAL_CREATION_FAILED', message: MESSAGES.WITHDRAWAL.WITHDRAWAL_CREATION_FAILED, traceId }); }
            const successPayload = { success: true, amount: requestedAmount, fee: withdrawalFee, newBalance, txId: txHash, txHash, status: 'pending', traceId, message: MESSAGES.WITHDRAWAL.WITHDRAWAL_SUCCESS };
            socket.emit('withdrawal_success', successPayload); socket.emit('withdrawal_requested', successPayload);
            io.to('admin_room').emit('admin_new_withdrawal_request', { txId: txHash, userId: socket.userId, username: user.username, amount: requestedAmount, fee: withdrawalFee, address: address.trim(), isOwner: user.is_owner === true, createdAt: new Date().toISOString(), traceId });
        } catch (e) { socket.emit('withdrawal_error', { code: 'SERVER_ERROR', message: MESSAGES.WITHDRAWAL.SERVER_ERROR, traceId }); }
    });
    socket.on('admin_emergency_stop', () => { if (!socket.isAdmin) return socket.emit('error', { code: 'NOT_ADMIN' }); globalEmergencyStop = true; gamePhase = 'stopped'; logCritical(`🛑 [ADMIN] Emergency stop by ${socket.adminEmail}`); io.emit('game_stopped', { reason: 'ADMIN_EMERGENCY', message: MESSAGES.GAME.GAME_STOPPED, timestamp: new Date().toISOString() }); socket.emit('emergency_stopped', { success: true }); });
    socket.on('admin_emergency_resume', () => { if (!socket.isAdmin) return socket.emit('error', { code: 'NOT_ADMIN' }); globalEmergencyStop = false; dailyLossTracker.totalLoss = 0; dailyLossTracker.totalWin = 0; hourlyLossTracker.totalLoss = 0; hourlyLossTracker.totalWin = 0; logCritical(`▶️ [ADMIN] Emergency resume by ${socket.adminEmail}`); io.emit('game_resumed', { message: MESSAGES.GAME.GAME_RESUMED, timestamp: new Date().toISOString() }); socket.emit('emergency_resumed', { success: true }); });
    socket.on('disconnect', () => { const player = activePlayers.get(socket.id); const betIds = []; if (player && player.slots) { for (const slot of player.slots) betIds.push(slot.betId); } if (socket.userId && betIds.length > 0) trackPlayerDisconnect(socket.userId, betIds, socket.id); activePlayers.delete(socket.id); for (const key of roundBets.keys()) { if (key.startsWith(`${socket.id}:`)) roundBets.delete(key); } broadcastPlayers(true); });
});

// ═════════════════════════════════════════════════════════════════
// 🌐 HTTP AUTH ENDPOINTS
// ═════════════════════════════════════════════════════════════════
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { username, email, password } = req.body || {};
        if (!username || typeof username !== 'string' || username.trim().length < 3) return res.status(400).json({ success: false, code: 'INVALID_USERNAME' });
        if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, code: 'INVALID_EMAIL' });
        if (!password || typeof password !== 'string' || password.length < 8) return res.status(400).json({ success: false, code: 'WEAK_PASSWORD' });
        const normalizedEmail = email.trim().toLowerCase();
        const { data: existing, error: existingErr } = await supabase.from('users').select('user_id').eq('email', normalizedEmail).maybeSingle();
        if (existingErr) { logCritical('❌ Register existing-check:', existingErr.message); return res.status(500).json({ success: false, code: 'DB_ERROR' }); }
        if (existing) return res.status(409).json({ success: false, code: 'EMAIL_ALREADY_EXISTS' });
        const userId = crypto.randomUUID();
        const passwordHash = await bcrypt.hash(password, 10);
        let depositAddress = null; try { depositAddress = paymentService.tryGetDepositAddress(userId) || null; } catch (e) { logCritical('⚠️ tryGetDepositAddress:', e.message); }
        const { data: newUser, error: insertErr } = await supabase.from('users').insert({ user_id: userId, username: username.trim(), email: normalizedEmail, password_hash: passwordHash, balance: 0, demo_balance: DEMO_BALANCE, deposit_address: depositAddress, total_deposited: 0, total_withdrawn: 0, total_won: 0, total_wagered: 0 }).select().single();
        if (insertErr) { logCritical('❌ Register insert:', insertErr.message); return res.status(500).json({ success: false, code: 'DB_ERROR' }); }
        const token = generateSessionToken(userId);
        res.json({ success: true, userId, username: newUser.username, email: normalizedEmail, token });
    } catch (e) { logCritical('❌ Register error:', e.stack || e.message); res.status(500).json({ success: false, code: 'SERVER_ERROR' }); }
});

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || typeof email !== 'string') return res.status(400).json({ success: false, code: 'INVALID_EMAIL' });
        if (!password || typeof password !== 'string') return res.status(400).json({ success: false, code: 'INVALID_PASSWORD' });
        const normalizedEmail = email.trim().toLowerCase();
        const { data: user, error } = await supabase.from('users').select('*').eq('email', normalizedEmail).maybeSingle();
        if (error) { logCritical('❌ Login query:', error.message); return res.status(500).json({ success: false, code: 'DB_ERROR' }); }
        if (!user) return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS' });
        const passwordValid = await bcrypt.compare(password, user.password_hash || '');
        if (!passwordValid) return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS' });
        if (user.is_banned || user.is_frozen) return res.status(403).json({ success: false, code: 'USER_RESTRICTED' });
        const token = generateSessionToken(user.user_id);
        res.json({ success: true, userId: user.user_id, username: user.username, email: normalizedEmail, token });
    } catch (e) { logCritical('❌ Login error:', e.stack || e.message); res.status(500).json({ success: false, code: 'SERVER_ERROR' }); }
});

function generateSessionToken(userId) { return jwt.sign({ userId, type: 'session' }, JWT_SIGN_SECRET, { algorithm: 'HS256', expiresIn: '7d', issuer: 'polo-game', audience: 'player' }); }

app.post('/api/admin/login', authLimiter, async (req, res) => {
    try {
        const { error: vErr, value: vData } = validate('adminLogin', req.body);
        if (vErr) return res.status(400).json({ success: false, code: 'INVALID_INPUT', details: Array.isArray(vErr) ? vErr.map(e => e.message) : [vErr.message] });
        req.body = vData;
        const { email, password } = req.body || {};
        const adminEmail = process.env.ADMIN_EMAIL || '';
        const adminPassword = process.env.ADMIN_PASSWORD || '';
        const emailOk = timingSafeEqualStr(String(email || ''), String(adminEmail));
        const passOk = timingSafeEqualStr(String(password || ''), String(adminPassword));
        if (emailOk && passOk) { const token = generateAdminToken(email); await logAdminAction(email, 'admin_login_success', email, req.ip); return res.json({ success: true, token, type: 'jwt', expiresIn: '8h' }); }
        await logAdminAction(email || 'unknown', 'admin_login_failed', email, req.ip);
        return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS' });
    } catch (e) { logCritical('❌ admin login error:', e.stack || e.message); res.status(500).json({ success: false, code: 'SERVER_ERROR' }); }
});

// ═════════════════════════════════════════════════════════════════
// 🌐 PUBLIC ENDPOINTS
// ═════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => { res.json({ success: true, status: 'ok', phase: gamePhase, timestamp: new Date().toISOString(), safeMode: SAFE_MODE, circuitTripped: isCircuitTripped(), uptime: process.uptime() }); });
app.get('/api/servers', (req, res) => { res.json({ success: true, primary: process.env.PRIMARY_SERVER_URL || process.env.ACTIVE_SERVER_URL || '', backup: process.env.BACKUP_SERVER_URL || '', active: process.env.ACTIVE_SERVER_URL || process.env.RENDER_EXTERNAL_URL || '' }); });
app.get('/api/ui-config', (req, res) => { res.json({ success: true, config: getPublicConfig(), version: UI_CONFIG.version }); });

app.post('/api/generate-deposit-address', authLimiter, verifyAppIntegrity, async (req, res) => {
    try {
        const { userId } = req.body || {};
        if (!userId) return res.status(400).json({ success: false, code: 'INVALID_USER_ID' });
        const user = await getUser(userId);
        if (!user) return res.status(404).json({ success: false, code: 'USER_NOT_FOUND' });
        let address = user.deposit_address;
        if (!address) { address = paymentService.tryGetDepositAddress(userId); if (address) await supabase.from('users').update({ deposit_address: address }).eq('user_id', userId); }
        if (!address) return res.status(500).json({ success: false, code: 'DEPOSIT_ADDRESS_FAILED' });
        res.json({ success: true, payAddress: address, paymentId: `deposit__${userId}__${Date.now()}`, network: 'Polygon (MATIC)', minDeposit: MIN_DEPOSIT, cached: !!user.deposit_address });
    } catch (e) { logCritical('❌ generate-deposit-address:', e.message); res.status(500).json({ success: false, code: 'SERVER_ERROR' }); }
});

// ═════════════════════════════════════════════════════════════════
// 🛠️ ADMIN ENDPOINTS
// ═════════════════════════════════════════════════════════════════
app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
    try {
        const { count: usersCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
        const { data: users } = await supabase.from('users').select('balance, total_deposited, total_withdrawn, total_wagered, total_won');
        const { data: pendingWithdrawals } = await supabase.from('transactions').select('id').eq('type', 'withdrawal').eq('status', 'pending');
        const ownerState = await getOwnerFinancialState();
        let totalBalance = 0, totalDeposited = 0, totalWithdrawn = 0, totalWagered = 0, totalWon = 0;
        for (const u of users || []) { totalBalance += parseFloat(u.balance || 0); totalDeposited += parseFloat(u.total_deposited || 0); totalWithdrawn += parseFloat(u.total_withdrawn || 0); totalWagered += parseFloat(u.total_wagered || 0); totalWon += parseFloat(u.total_won || 0); }
        let ownerWalletBalance = 0, ownerPolBalance = 0, ownerPolStatus = 'unknown';
        try { const usdtBal = await usdtContract.balanceOf(adminWallet.address); ownerWalletBalance = parseFloat(ethers.formatUnits(usdtBal, 6)); const polBal = await provider.getBalance(adminWallet.address); ownerPolBalance = parseFloat(ethers.formatEther(polBal)); ownerPolStatus = ownerPolBalance > 0.5 ? 'ok' : 'low'; } catch (_) {}
        res.json({ success: true, stats: { usersCount: usersCount || 0, totalPlatformBalance: totalBalance, totalDeposited, totalWithdrawn, totalWagered, totalWon, ownerProfit: ownerState.withdrawable, totalCommission: ownerState.totalCommission, totalDeficit: ownerState.totalDeficit, pendingWithdrawals: (pendingWithdrawals || []).length, ownerWalletBalance, ownerPolBalance, ownerPolStatus, lastUpdated: new Date().toISOString(), safeMode: SAFE_MODE, circuitTripped: isCircuitTripped() } });
    } catch (e) { logCritical('❌ admin/stats:', e.message); res.status(500).json({ success: false, code: 'SERVER_ERROR' }); }
});

// ✅ عرض جميع طلبات السحب المعلقة فوراً للأدمن
app.get('/api/admin/withdrawals/pending', verifyAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase.from('transactions').select('*').eq('type', 'withdrawal').eq('status', 'pending').order('created_at', { ascending: true });
        if (error) throw error;
        const withdrawals = [];
        for (const tx of data || []) {
            const user = await getUser(tx.user_id);
            withdrawals.push({ ...tx, username: user?.username || 'Unknown', readyNow: true });
        }
        res.json({ success: true, withdrawals });
    } catch (e) { logCritical('❌ admin/withdrawals/pending:', e.message); res.status(500).json({ success: false, code: 'SERVER_ERROR' }); }
});

// ✅ قبول السحب وتحويله مباشرة (Direct) مع منع التكرار وإشعار الأدمن عند أي خطأ
app.post('/api/admin/withdrawal/update', verifyAdmin, adminLimiter, async (req, res) => {
    let tx = null;
    try {
        const { error: vErr, value } = validate('adminWithdrawalUpdate', req.body);
        if (vErr) return res.status(400).json({ success: false, code: 'INVALID_INPUT', details: vErr });
        const { txId, status, otpCode, useBackupCode } = value;

        if (process.env.ADMIN_2FA_SECRET) {
            if (!otpCode) return res.status(400).json({ success: false, code: 'OTP_REQUIRED' });
            let valid = false;
            try { if (!useBackupCode && speakeasy) valid = speakeasy.totp.verify({ secret: process.env.ADMIN_2FA_SECRET, encoding: 'base32', token: otpCode, window: 1 }); } catch (_) {}
            if (!valid) return res.status(401).json({ success: false, code: useBackupCode ? 'INVALID_BACKUP_CODE' : 'INVALID_OTP' });
        }

        const { data: foundTx } = await supabase.from('transactions').select('*').eq('tx_hash', txId).eq('type', 'withdrawal').maybeSingle();
        tx = foundTx;
        if (!tx) return res.status(404).json({ success: false, code: 'TX_NOT_FOUND' });
        if (tx.status !== 'pending') return res.status(400).json({ success: false, code: 'ALREADY_PROCESSED' });

        if (status === 'rejected') {
            const refundAmount = parseFloat(tx.total_amount || tx.amount);
            const credit = await atomicCreditBalance(tx.user_id, refundAmount);
            if (!credit.success) {
                emitAdminWithdrawalError({ txId, userId: tx.user_id, amount: tx.amount, address: tx.address, stage: 'REJECT_REFUND_FAILED', error: credit.reason || 'REFUND_FAILED' });
                return res.status(500).json({ success: false, code: 'REFUND_FAILED' });
            }
            await supabase.from('transactions').update({ status: 'rejected' }).eq('id', tx.id);
            await logAdminAction(req.admin.email, 'withdrawal_rejected', tx.user_id, req.ip, { txId, amount: tx.amount });
            return res.json({ success: true, message: 'Rejected and refunded' });
        }

        if (status === 'completed') {
            if (SAFE_MODE) {
                emitAdminWithdrawalError({ txId, userId: tx.user_id, amount: tx.amount, address: tx.address, stage: 'PRECHECK', error: 'SAFE_MODE is enabled' });
                return res.status(403).json({ success: false, code: 'SAFE_MODE_BLOCKED' });
            }
            if (isCircuitTripped()) {
                emitAdminWithdrawalError({ txId, userId: tx.user_id, amount: tx.amount, address: tx.address, stage: 'PRECHECK', error: `Circuit breaker tripped: ${CIRCUIT_BREAKER.reason || 'SECURITY'}` });
                return res.status(423).json({ success: false, code: 'CIRCUIT_BREAKER' });
            }

            const { data: lockedTx } = await supabase.from('transactions').update({ status: 'processing' }).eq('id', tx.id).eq('status', 'pending').select().maybeSingle();
            if (!lockedTx) return res.status(409).json({ success: false, code: 'ALREADY_PROCESSING' });

            let receiptHash = null;
            try {
                const amountWei = ethers.parseUnits(tx.amount.toString(), 6);
                const transferTx = await usdtContract.transfer(tx.address, amountWei);
                receiptHash = transferTx.hash;

                const receipt = await waitWithTimeout(transferTx, 180000);
                if (receipt.confirmations < 3) { await transferTx.wait(3); }

                await supabase.from('transactions').update({ status: 'completed', tx_hash: receipt.hash, confirmed_at: new Date().toISOString() }).eq('id', tx.id);
                const user = await getUser(tx.user_id);
                if (user) await supabase.from('users').update({ total_withdrawn: parseFloat(user.total_withdrawn || 0) + parseFloat(tx.amount) }).eq('user_id', tx.user_id);
                await logAdminAction(req.admin.email, 'withdrawal_completed', tx.user_id, req.ip, { txId, amount: tx.amount, txHash: receipt.hash });
                io.to('admin_room').emit('admin_withdrawal_completed', { txId, userId: tx.user_id, amount: tx.amount, address: tx.address, txHash: receipt.hash, timestamp: new Date().toISOString() });
                return res.json({ success: true, txHash: receipt.hash });
            } catch (transferErr) {
                const errMsg = transferErr?.shortMessage || transferErr?.message || String(transferErr);
                logCritical('❌ Direct transfer failed:', errMsg);

                if (!receiptHash) {
                    const refundAmount = parseFloat(tx.total_amount || tx.amount);
                    const credit = await atomicCreditBalance(tx.user_id, refundAmount);
                    if (!credit.success) await logRefund(tx.user_id, refundAmount, 'WITHDRAWAL_DIRECT_FAILED_REFUND', { txId, error: errMsg });
                    await supabase.from('transactions').update({ status: 'pending' }).eq('id', tx.id);
                } else {
                    await supabase.from('transactions').update({ status: 'processing', tx_hash: receiptHash }).eq('id', tx.id);
                }

                emitAdminWithdrawalError({ txId, userId: tx.user_id, amount: tx.amount, address: tx.address, txHash: receiptHash, stage: receiptHash ? 'CONFIRM_OR_DB_AFTER_TX' : 'BLOCKCHAIN_TRANSFER', error: errMsg });
                return res.status(500).json({ success: false, code: 'TRANSFER_FAILED', message: errMsg, txHash: receiptHash });
            }
        }

        res.status(400).json({ success: false, code: 'INVALID_STATUS' });
    } catch (e) {
        const errMsg = e?.message || String(e);
        logCritical('❌ admin/withdrawal/update:', errMsg);
        emitAdminWithdrawalError({ txId: tx?.tx_hash || req.body?.txId || 'unknown', userId: tx?.user_id || null, amount: tx?.amount || null, address: tx?.address || null, stage: 'SERVER_EXCEPTION', error: errMsg });
        res.status(500).json({ success: false, code: 'SERVER_ERROR', message: errMsg });
    }
});

app.get('/api/admin/2fa/status', verifyAdmin, async (req, res) => { res.json({ success: true, enabled: !!process.env.ADMIN_2FA_SECRET }); });
app.get('/api/admin/config', verifyAdmin, async (req, res) => { res.json({ success: true, config: UI_CONFIG }); });

app.post('/api/admin/config', verifyAdmin, adminLimiter, async (req, res) => {
    try {
        const incoming = req.body?.config || req.body;
        if (!incoming || typeof incoming !== 'object') return res.status(400).json({ success: false, code: 'INVALID_CONFIG' });
        const merged = deepMerge(UI_CONFIG, incoming);
        const saved = await saveAppConfig(merged);
        await logAdminAction(req.admin.email, 'config_updated', 'global', req.ip, { version: saved.version });
        res.json({ success: true, version: saved.version, config: saved.config });
    } catch (e) {
        logCritical('❌ admin/config:', e.message);
        res.status(500).json({ success: false, code: 'SERVER_ERROR' });
    }
});

app.post('/api/admin/config/reset', verifyAdmin, async (req, res) => {
    try {
        const freshDefault = JSON.parse(JSON.stringify(DEFAULT_UI_CONFIG));
        const saved = await saveAppConfig(freshDefault);
        await logAdminAction(req.admin.email, 'config_reset', 'global', req.ip, { version: saved.version });
        res.json({ success: true, version: saved.version, config: saved.config });
    } catch (e) {
        logCritical('❌ admin/config/reset:', e.message);
        res.status(500).json({ success: false, code: 'SERVER_ERROR' });
    }
});

app.get('/api/admin/flagged-users', verifyAdmin, async (req, res) => { try { const { data } = await supabase.from('users').select('user_id, username, email, is_flagged, flag_reason, flagged_at, total_won, total_wagered').eq('is_flagged', true).order('flagged_at', { ascending: false }); res.json({ success: true, users: data || [] }); } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR' }); } });
app.post('/api/admin/user/unflag', verifyAdmin, async (req, res) => { try { const { userId } = req.body || {}; if (!userId) return res.status(400).json({ success: false, code: 'INVALID_USER_ID' }); await supabase.from('users').update({ is_flagged: false, flag_reason: null, flagged_at: null }).eq('user_id', userId); await logAdminAction(req.admin.email, 'user_unflagged', userId, req.ip); res.json({ success: true }); } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR' }); } });

// ═══ Admin: Support ═══
app.get('/api/admin/support/conversations', verifyAdmin, async (req, res) => { try { const conversations = await supportService.listConversations(); res.json({ success: true, conversations }); } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR' }); } });
app.get('/api/admin/support/messages', verifyAdmin, async (req, res) => { try { const { conversationId } = req.query; if (!conversationId) return res.status(400).json({ success: false, code: 'INVALID_INPUT' }); const messages = await supportService.getMessages(conversationId); await supportService.markReadByAdmin(conversationId); res.json({ success: true, messages }); } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR' }); } });
app.post('/api/admin/support/accept', verifyAdmin, async (req, res) => { try { const { conversationId } = req.body || {}; const conv = await supportService.acceptConversation(conversationId); res.json({ success: true, conversation: conv }); } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR' }); } });
app.post('/api/admin/support/reject', verifyAdmin, async (req, res) => { try { const { conversationId, reason } = req.body || {}; const conv = await supportService.rejectConversation(conversationId, reason); res.json({ success: true, conversation: conv }); } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR' }); } });
app.post('/api/admin/support/reply', verifyAdmin, async (req, res) => { try { const { conversationId, message } = req.body || {}; if (!message || message.trim().length === 0) return res.status(400).json({ success: false, code: 'EMPTY_MESSAGE' }); const msg = await supportService.addMessage(conversationId, 'admin', req.admin.email, message); io.to(`support_${conversationId}`).emit('support_message', { conversationId, message: msg }); res.json({ success: true, message: msg }); } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR' }); } });
app.post('/api/admin/support/close', verifyAdmin, async (req, res) => { try { const { conversationId } = req.body || {}; await supportService.closeConversation(conversationId); res.json({ success: true }); } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR' }); } });

// ═══ Admin: Circuit Breaker ═══
app.get('/api/admin/circuit/status', verifyAdmin, (req, res) => { res.json({ success: true, tripped: isCircuitTripped(), reason: CIRCUIT_BREAKER.reason, trippedAt: CIRCUIT_BREAKER.trippedAt, recentErrors: CIRCUIT_BREAKER.errors.length, threshold: CIRCUIT_BREAKER.threshold }); });
app.post('/api/admin/circuit/reset', verifyAdmin, adminLimiter, async (req, res) => { try { const prev = CIRCUIT_BREAKER.reason; resetCircuit(); await logAdminAction(req.admin.email, 'circuit_reset', 'global', req.ip, { previousReason: prev }); if (typeof io !== 'undefined' && io) io.emit('game_resumed', { message: '✅ تمت إعادة تشغيل النظام', timestamp: new Date().toISOString() }); res.json({ success: true, message: 'Circuit reset', tripped: false }); } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR' }); } });

// ═════════════════════════════════════════════════════════════════
// 🚀 STARTUP
// ═════════════════════════════════════════════════════════════════
(async () => {
    try {
        await loadAppConfig();
        await loadRecentHistory();
        await startDepositListener();
        await provablyFair.init(supabase);
        await recoverPendingBets();
        await monitorPolEnhanced();

        gameLoop();

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, '0.0.0.0', () => {
            console.error('');
            console.error('═══════════════════════════════════════════════════');
            console.error('🏆 POLO GAME SERVER v9.1-PRODUCTION');
            console.error('═══════════════════════════════════════════════════');
            console.error(`✅ Listening on port ${PORT}`);
            console.error(`🛡️  SAFE MODE: ${SAFE_MODE ? 'ON (withdrawals blocked)' : 'OFF'}`);
            console.error(`💰 Owner Commission: ${(OWNER_POOL_SHARE * 100).toFixed(0)}%`);
            console.error(`📊 Max Bet: $${MAX_BET} | Max Withdrawal: $${MAX_WITHDRAWAL}`);
            console.error(`⏱️  Tick Interval: ${TICK_INTERVAL_MS}ms`);
            console.error(`⏱️  Players Update: ${PLAYERS_UPDATE_INTERVAL_MS}ms`);
            console.error(`😴 Sleep Policy: Render will spin down after 15min of inactivity`);
            console.error('═══════════════════════════════════════════════════');
            console.error('');
        });
    } catch (err) {
        logCritical('❌ Startup error:', err.message);
        process.exit(1);
    }
})();
