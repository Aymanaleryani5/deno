// ==========================================================
// 🚀 Deno Deploy - Phone Search API (بدون Firecrawl)
// ==========================================================

// ==========================================================
// 📦 نظام التخزين المؤقت (In-Memory Cache)
// ==========================================================
class MemoryCache {
  constructor() {
    this.cache = new Map();
    this.defaultTTL = 60; // 3 أيام
  }

  async match(request) {
    const url = new URL(request.url);
    const key = url.pathname + url.search;
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data.clone();
  }

  async put(request, response) {
    const url = new URL(request.url);
    const key = url.pathname + url.search;
    const expiry = Date.now() + (this.defaultTTL * 1000);
    this.cache.set(key, { data: response.clone(), expiry });
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiry) {
        this.cache.delete(key);
      }
    }
  }
}

// ==========================================================
// 📊 نظام تحديد المعدل (Rate Limiting)
// ==========================================================
class RateLimiter {
  constructor() {
    this.requests = new Map();
    this.windowSeconds = 3;
  }
  
  isRateLimited(ip) {
    const now = Math.floor(Date.now() / 1000);
    const record = this.requests.get(ip);
    
    if (!record) {
      this.requests.set(ip, { count: 1, firstRequest: now });
      return { limited: false };
    }
    
    const timeSinceFirst = now - record.firstRequest;
    
    if (timeSinceFirst < this.windowSeconds) {
      return { 
        limited: true, 
        secondsLeft: this.windowSeconds - timeSinceFirst 
      };
    } else {
      this.requests.set(ip, { count: 1, firstRequest: now });
      return { limited: false };
    }
  }
  
  cleanup() {
    const now = Math.floor(Date.now() / 1000);
    for (const [ip, record] of this.requests) {
      if (now - record.firstRequest > this.windowSeconds * 2) {
        this.requests.delete(ip);
      }
    }
  }
}

// ==========================================================
// 🌐 متغيرات البيئة
// ==========================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://qfcsaiyuyxhibidrrmha.supabase.co";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

// إنشاء مثيلات
const cache = new MemoryCache();
const rateLimiter = new RateLimiter();

// تنظيف دوري
setInterval(() => {
  cache.cleanup();
  rateLimiter.cleanup();
}, 60000);

console.log('🚀 جاري تشغيل الخادم...');

// ==========================================================
// 🚀 الخادم الرئيسي
// ==========================================================
async function handler(request) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': ''
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // --- 1. نظام حماية الـ IP ---
    const userIP = request.headers.get('CF-Connecting-IP') || 
                   request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
                   'anonymous';
    
    const rateLimitResult = rateLimiter.isRateLimited(userIP);
    
    if (rateLimitResult.limited) {
      return new Response(JSON.stringify({
        success: false,
        results: [],
        total: 0,
        error: 'مهلاً! الرجاء الانتظار',
        message: `⏳ يرجى الانتظار ${rateLimitResult.secondsLeft} ثواني بين عمليات البحث`
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
      });
    }

    // --- 2. جلب معلمة البحث ---
    let query = null;
    if (request.method === 'GET') {
      query = new URL(request.url).searchParams.get('query');
    } else {
      try {
        const body = await request.json();
        query = body.query;
      } catch(e) {
        query = null;
      }
    }

    if (!query) {
      return new Response(JSON.stringify({ 
        success: false, 
        results: [], 
        total: 0, 
        error: 'البحث فارغ' 
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // --- 3. تنظيف رقم الهاتف ---
    let cleanPhone = query.trim().replace(/\s+/g, '').replace(/[-()]/g, '');
    if (cleanPhone.startsWith('00')) cleanPhone = cleanPhone.substring(2);
    else if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);
    else if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
    
    if (cleanPhone.startsWith('967')) cleanPhone = cleanPhone.substring(3);

    const provider = detectProvider(cleanPhone);
    let databasePhone = cleanPhone;
    if (provider !== 'رقم دولي' && !databasePhone.startsWith('0')) {
      databasePhone = '0' + databasePhone;
    }

    const scrapePhone = provider !== 'رقم دولي' ? '+967' + cleanPhone : '+' + cleanPhone;

    // ==========================================================
    // 🛡️ [المستوى 1] الكاش المحلي
    // ==========================================================
    const mainCacheUrl = new URL(request.url);
    mainCacheUrl.pathname = `/v1/phone-cache/${encodeURIComponent(databasePhone)}`;
    mainCacheUrl.search = '';
    const mainCacheKey = new Request(mainCacheUrl.toString(), { method: 'GET' });
    
    try {
      const cachedResponse = await cache.match(mainCacheKey);
      if (cachedResponse) {
        const responseHeaders = new Headers(cachedResponse.headers);
        responseHeaders.set('X-Cache-Status', 'HIT');
        responseHeaders.set('X-Cache-Level', 'DENO_MEMORY_CACHE');
        for (const [key, value] of Object.entries(corsHeaders)) {
          responseHeaders.set(key, value);
        }
        return new Response(cachedResponse.body, { 
          status: 200, 
          headers: responseHeaders 
        });
      }
    } catch(e) {
      console.error('❌ فشل قراءة الكاش:', e);
    }

    // ==========================================================
    // 🛡️ [المستوى 2] قراءة من Supabase
    // ==========================================================
    if (SUPABASE_ANON_KEY) {
      try {
        console.log(`🔎 البحث في Supabase عن: ${databasePhone}`);
        
        const dbResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/numbers?phone=eq.${databasePhone}&select=*`,
          {
            headers: {
              'apikey': SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            }
          }
        );

        if (dbResponse.ok) {
          const existingRecords = await dbResponse.json();
          if (existingRecords && existingRecords.length > 0) {
            console.log(`✅ تم العثور على الرقم في Supabase!`);
            
            const results = existingRecords.map((rec) => {
              const name = rec.name || rec.contact_name || rec.full_name || rec.username || 'اسم غير معروف';
              const phone = rec.phone || rec.phone_number || databasePhone;
              const src = rec.source || rec.data_source || 'قاعدة البيانات';
              const prov = rec.provider || rec.telecom || provider;
              const date = rec.created_at || rec.added_at || new Date().toISOString();

              return {
                name: name,
                phone: phone,
                source: src,
                provider: prov,
                formattedDate: new Date(date).toLocaleDateString('ar-EG')
              };
            });

            const finalResponseData = JSON.stringify({ 
              success: true, 
              results, 
              total: results.length,
              source: 'supabase_cache',
              cached_at: new Date().toISOString()
            });

            const dbCacheResponse = new Response(finalResponseData, {
              status: 200,
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'public, max-age=259200',
                ...corsHeaders
              }
            });

            await cache.put(mainCacheKey, dbCacheResponse.clone());
            return dbCacheResponse;
          }
        }
      } catch (dbErr) {
        console.error('❌ خطأ في Supabase:', dbErr);
      }
    }

    // ==========================================================
    // 🌐 [المستوى 3] جلب مباشر (بدون Firecrawl)
    // ==========================================================
    let names = [];
    let success = false;
    let lastError = null;
    let source = '';
    let rawData = null;

    console.log('🌐 جلب البيانات مباشرة...');
    
    try {
      const targetUrl = `https://3.nabx.net/wp-admin/admin-ajax.php?action=alosh_search&phone=${encodeURIComponent(scrapePhone)}`;
      console.log(`📡 جلب البيانات من: ${targetUrl}`);
      
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/html, */*',
          'Accept-Language': 'ar,en;q=0.9',
          'Referer': 'https://3.nabx.net/'
        }
      });
      
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        console.log(`📄 نوع المحتوى: ${contentType}`);
        
        if (contentType.includes('application/json')) {
          const jsonData = await response.json();
          rawData = jsonData;
          console.log('✅ استجابة JSON مستلمة');
          
          // استخراج من JSON
          const extractedNames = extractNamesFromJSON(jsonData);
          if (extractedNames.length > 0) {
            names = extractedNames;
            success = true;
            source = 'direct_json';
            console.log(`✅ استخراج ${names.length} اسم من JSON`);
          }
        } else {
          const htmlContent = await response.text();
          rawData = { html: htmlContent };
          console.log(`📄 طول محتوى HTML: ${htmlContent.length} حرف`);
          
          if (htmlContent && htmlContent.length >= 50) {
            // استخراج من HTML
            const extractedNames = extractNamesFromResponse(htmlContent);
            if (extractedNames.length > 0) {
              names = extractedNames;
              success = true;
              source = 'direct_html';
              console.log(`✅ استخراج ${names.length} اسم من HTML`);
            } else {
              // طريقة بديلة
              const alternativeNames = extractNamesAlternative(htmlContent);
              if (alternativeNames.length > 0) {
                names = alternativeNames;
                success = true;
                source = 'alternative_html';
                console.log(`✅ استخراج ${names.length} اسم (طريقة بديلة)`);
              }
            }
          }
        }
      } else {
        console.log(`⚠️ فشل الجلب: ${response.status}`);
        lastError = `HTTP error: ${response.status}`;
      }
    } catch (e) {
      console.error('❌ خطأ في الجلب:', e);
      lastError = `Fetch error: ${e.message}`;
    }

    // ==========================================================
    // 📊 إذا لم يتم العثور على نتائج
    // ==========================================================
    if (!success || names.length === 0) {
      return new Response(JSON.stringify({ 
        success: false, 
        results: [], 
        total: 0, 
        error: lastError || 'لم يتم العثور على نتائج',
        debug: {
          phone: scrapePhone,
          provider: provider,
          source: source
        }
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
      });
    }

    // --- 4. تجهيز النتيجة ---
    const results = names.map(name => ({
      name: name,
      phone: databasePhone,
      source: 'جلب مباشر',
      provider: provider,
      formattedDate: new Date().toLocaleDateString('ar-EG')
    }));

    const finalResponseData = JSON.stringify({ 
      success: true, 
      results, 
      total: results.length,
      source: source,
      cached_at: new Date().toISOString()
    });

    const mainResponse = new Response(finalResponseData, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=259200',
        ...corsHeaders
      }
    });

    await cache.put(mainCacheKey, mainResponse.clone());
    return mainResponse;

  } catch (e) {
    console.error('❌ خطأ عام:', e);
    return new Response(JSON.stringify({ 
      success: false, 
      results: [], 
      total: 0, 
      error: e.message,
      stack: e.stack 
    }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
    });
  }
}

// ==========================================================
// 📝 دوال استخراج الأسماء (نفس الطريقة)
// ==========================================================

function extractNamesFromJSON(jsonData) {
  const names = [];
  
  try {
    if (jsonData.result) {
      const text = jsonData.result;
      
      const fameMatch = text.match(/اسم الشهرة[:\s]+([^\n]+)/);
      if (fameMatch) {
        let name = fameMatch[1].trim();
        name = cleanExtractedName(name);
        if (name && name.length > 2 && !names.includes(name) && !/^\+?\d+$/.test(name)) {
          names.push(name);
        }
      }
      
      const numberedMatches = text.match(/\d+\s*[-–—]\s*([^\d\n]+)/g);
      if (numberedMatches) {
        numberedMatches.forEach(m => {
          const nameMatch = m.match(/\d+\s*[-–—]\s*([^\d\n]+)/);
          if (nameMatch) {
            let name = nameMatch[1].trim();
            name = cleanExtractedName(name);
            if (name && name.length > 2 && !names.includes(name) && !/^\+?\d+$/.test(name)) {
              names.push(name);
            }
          }
        });
      }
      
      const arabicPattern = /[\u0600-\u06FF]{3,}(?:\s+[\u0600-\u06FF]{3,}){0,3}/g;
      let arabicMatch;
      while ((arabicMatch = arabicPattern.exec(text)) !== null) {
        let name = arabicMatch[0];
        name = cleanExtractedName(name);
        if (name.length > 2 && !names.includes(name) && !name.includes('ل') && !/^\+?\d+$/.test(name)) {
          names.push(name);
        }
      }
    }
  } catch (e) {
    console.error('خطأ في استخراج الأسماء من JSON:', e);
  }
  
  return [...new Set(names)]
    .filter(name => !/^[\d+\s]+$/.test(name))
    .slice(0, 20);
}

function extractNamesFromResponse(html) {
  const names = [];
  
  const numberedPattern = /(\d+)\s*[-–—]\s*([^\d\n<]+)/g;
  let match;
  while ((match = numberedPattern.exec(html)) !== null) {
    let name = match[2];
    name = cleanExtractedName(name);
    if (name.length > 2 && !names.includes(name) && !/^\+?\d+$/.test(name)) {
      names.push(name);
    }
  }
  
  const arabicNamePattern = /[\u0600-\u06FF]{3,}(?:\s+[\u0600-\u06FF]{3,}){0,3}/g;
  let arabicMatch;
  while ((arabicMatch = arabicNamePattern.exec(html)) !== null) {
    let name = arabicMatch[0];
    name = cleanExtractedName(name);
    if (name.length > 2 && !names.includes(name) && !name.includes('ل') && !/^\+?\d+$/.test(name)) {
      names.push(name);
    }
  }
  
  const nameTags = /<[^>]*name[^>]*>([^<]+)<\/[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = nameTags.exec(html)) !== null) {
    let name = tagMatch[1];
    name = cleanExtractedName(name);
    if (name.length > 2 && !names.includes(name) && /[\u0600-\u06FF]/.test(name) && !/^\+?\d+$/.test(name)) {
      names.push(name);
    }
  }
  
  return [...new Set(names)].slice(0, 100);
}

function extractNamesAlternative(html) {
  const names = [];
  
  const textContent = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  
  const arabicPattern = /[\u0600-\u06FF]{3,}(?:\s+[\u0600-\u06FF]{3,}){0,2}/g;
  let match;
  while ((match = arabicPattern.exec(textContent)) !== null) {
    let name = match[0];
    name = cleanExtractedName(name);
    if (name.length > 2 && !names.includes(name) && !name.includes('ل') && name.length < 30 && !/^\+?\d+$/.test(name)) {
      names.push(name);
    }
  }
  
  const keywords = ['اسم', 'الاسم', 'name', 'user', 'contact', 'صاحب', 'مالك', 'الشهرة', 'المستخدم', 'العميل'];
  for (const keyword of keywords) {
    const regex = new RegExp(`${keyword}[\\s:]*([^\\n<,]+)`, 'gi');
    let match;
    while ((match = regex.exec(textContent)) !== null) {
      let name = match[1];
      name = cleanExtractedName(name);
      if (name.length > 2 && !names.includes(name) && /[\u0600-\u06FF]/.test(name) && !/^\+?\d+$/.test(name)) {
        names.push(name);
      }
    }
  }
  
  const pattern = /\d+[\s-]+([\u0600-\u06FF\s]+)/g;
  let patternMatch;
  while ((patternMatch = pattern.exec(textContent)) !== null) {
    let name = patternMatch[1];
    name = cleanExtractedName(name);
    if (name.length > 2 && !names.includes(name) && !/^\+?\d+$/.test(name)) {
      names.push(name);
    }
  }
  
  return [...new Set(names)].slice(0, 50);
}

function cleanExtractedName(name) {
  return name
    .replace(/\{.*?\}/g, '')
    .replace(/[\\{}{}\[\]"':\-_,\/]/g, ' ')
    .replace(/\b(info|country|n|null|undefined|الرقم|اسم|search|phone|نتائج|البحث|للرقم|الشهرة|السجلات|المكتشفة|الأكثر|شيوعاً|اليمن|من|هذا|هذه|كان|مع|عن|على|الى|حتى|بين|أو|و|ف|في|إلى|على|عن|من|إلى|عند|ب|ك|ل|لل|و|ثم|حتى|لكن|ولا|أو|ثم|حيث|بين|عندما|ذلك|هذه|هذا|التي|الذي|الذين|اللاتي|اللواتي|منذ|خلال|بسبب|دون|بينما|حيثما|كلما|متى|أين|كيف|إذا|لن|لم|ما|لا|ليس|سوف|قد|ربما|لعل|ليت|لابد|لعل|لكي|كي|حتّى|حتى)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectProvider(cleanPhone) {
  if (/^(77|78)[0-9]{7}$/.test(cleanPhone)) return 'يمن موبايل';
  if (/^(73)[0-9]{7}$/.test(cleanPhone)) return 'YOU';
  if (/^(71)[0-9]{7}$/.test(cleanPhone)) return 'سبأفون';
  if (/^(70)[0-9]{7}$/.test(cleanPhone)) return 'واي';
  return 'رقم دولي';
}

// ==========================================================
// 🚀 تشغيل الخادم
// ==========================================================
console.log('🚀 تشغيل خادم Deno Deploy...');
console.log('📌 الخادم يعمل على المنفذ 8000');
console.log('✅ تم إزالة Firecrawl واستخدام الجلب المباشر');

Deno.serve({ port: 8000, hostname: "0.0.0.0" }, handler);
