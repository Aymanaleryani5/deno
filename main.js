// ==========================================================
// 🚀 Deno Deploy - Phone Search API (محدث)
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
    // 🌐 [المستوى 3] جلب مباشر عبر Deno Deploy مع محاولات متعددة
    // ==========================================================
    let names = [];
    let success = false;
    let lastError = null;
    let source = '';

    // محاولة 1: الطريقة الأساسية
    console.log(`🌐 محاولة 1: جلب البيانات للرقم ${scrapePhone}...`);
    
    try {
      const targetUrl = `https://b.raw2fid.net/wp-admin/admin-ajax.php?action=alosh_search&phone=${encodeURIComponent(scrapePhone)}`;
      console.log(`📡 URL: ${targetUrl}`);
      
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/html, */*',
          'Accept-Language': 'ar,en;q=0.9',
          'Referer': 'https://b.raw2fid.net/',
          'Cache-Control': 'no-cache'
        }
      });
      
      console.log(`📊 حالة الاستجابة: ${response.status}`);
      
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        console.log(`📄 نوع المحتوى: ${contentType}`);
        
        // محاولة استخراج من JSON
        if (contentType.includes('application/json')) {
          const jsonData = await response.json();
          console.log(`📦 JSON المستلم:`, JSON.stringify(jsonData).substring(0, 200));
          
          const extractedNames = extractNamesFromJSONImproved(jsonData);
          if (extractedNames.length > 0) {
            names = extractedNames;
            success = true;
            source = 'direct_json';
            console.log(`✅ استخراج ${names.length} اسم من JSON`);
          } else {
            console.log('⚠️ لم يتم العثور على أسماء في JSON');
          }
        } else {
          // استخراج من HTML
          const htmlContent = await response.text();
          console.log(`📄 طول محتوى HTML: ${htmlContent.length} حرف`);
          
          if (htmlContent && htmlContent.length >= 50) {
            // محاولات متعددة لاستخراج الأسماء
            const methods = [
              { name: 'من HTML', func: extractNamesFromResponse },
              { name: 'بديل', func: extractNamesAlternative },
              { name: 'متقدم', func: extractNamesAdvanced }
            ];
            
            for (const method of methods) {
              const extractedNames = method.func(htmlContent);
              if (extractedNames.length > 0) {
                names = extractedNames;
                success = true;
                source = `direct_${method.name}`;
                console.log(`✅ استخراج ${names.length} اسم ${method.name}`);
                break;
              }
            }
            
            if (!success) {
              console.log('⚠️ لم يتم العثور على أسماء في HTML');
              // عرض عينة من HTML للتحقق
              console.log(`📝 عينة HTML: ${htmlContent.substring(0, 300)}...`);
            }
          } else {
            console.log('⚠️ محتوى HTML قصير جداً');
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

    // محاولة 2: استخدام Google proxy إذا فشلت المحاولة الأولى
    if (!success) {
      console.log('🌐 محاولة 2: استخدام Google proxy...');
      try {
        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(`https://b.raw2fid.net/wp-admin/admin-ajax.php?action=alosh_search&phone=${encodeURIComponent(scrapePhone)}`)}`;
        
        const response = await fetch(proxyUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        if (response.ok) {
          const htmlContent = await response.text();
          if (htmlContent && htmlContent.length >= 50) {
            const extractedNames = extractNamesAdvanced(htmlContent);
            if (extractedNames.length > 0) {
              names = extractedNames;
              success = true;
              source = 'proxy';
              console.log(`✅ استخراج ${names.length} اسم عبر الـ Proxy`);
            }
          }
        }
      } catch (e) {
        console.log(`⚠️ فشل الـ Proxy: ${e.message}`);
      }
    }

    // ==========================================================
    // 📊 إذا لم يتم العثور على نتائج
    // ==========================================================
    if (!success || names.length === 0) {
      return new Response(JSON.stringify({ 
        success: false, 
        results: [], 
        total: 0, 
        error: 'لم يتم العثور على نتائج',
        debug: {
          phone: scrapePhone,
          provider: provider,
          source: source,
          lastError: lastError
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
// 📝 دوال استخراج الأسماء (محسنة)
// ==========================================================

function extractNamesFromJSONImproved(jsonData) {
  const names = [];
  
  try {
    // إذا كان هناك مصفوفة نتائج
    if (Array.isArray(jsonData)) {
      jsonData.forEach(item => {
        if (item.name) {
          let name = cleanExtractedName(item.name);
          if (name && name.length > 2 && !names.includes(name)) {
            names.push(name);
          }
        }
        if (item.full_name) {
          let name = cleanExtractedName(item.full_name);
          if (name && name.length > 2 && !names.includes(name)) {
            names.push(name);
          }
        }
        if (item.username) {
          let name = cleanExtractedName(item.username);
          if (name && name.length > 2 && !names.includes(name)) {
            names.push(name);
          }
        }
      });
    }
    
    // إذا كان هناك كائن result
    if (jsonData.result) {
      const text = jsonData.result;
      
      // استخراج الأسماء المرقمة
      const numberedMatches = text.match(/(\d+)\s*[-–—:]\s*([^\d\n]+)/g);
      if (numberedMatches) {
        numberedMatches.forEach(m => {
          const match = m.match(/(\d+)\s*[-–—:]\s*([^\d\n]+)/);
          if (match) {
            let name = cleanExtractedName(match[2]);
            if (name && name.length > 2 && !names.includes(name) && !/^\d+$/.test(name)) {
              names.push(name);
            }
          }
        });
      }
      
      // استخراج الأسماء العربية
      const arabicPattern = /[\u0600-\u06FF]{2,}(?:\s+[\u0600-\u06FF]{2,}){0,4}/g;
      let match;
      while ((match = arabicPattern.exec(text)) !== null) {
        let name = cleanExtractedName(match[0]);
        if (name.length > 2 && !names.includes(name) && 
            !/^(الرقم|اسم|نتائج|البحث|للرقم|الشهرة|السجلات|المكتشفة|الأكثر|شيوعاً|اليمن)$/.test(name)) {
          names.push(name);
        }
      }
    }
    
    // البحث في جميع خصائص الكائن
    Object.keys(jsonData).forEach(key => {
      if (typeof jsonData[key] === 'string' && jsonData[key].length > 5) {
        const text = jsonData[key];
        const arabicPattern = /[\u0600-\u06FF]{2,}(?:\s+[\u0600-\u06FF]{2,}){0,4}/g;
        let match;
        while ((match = arabicPattern.exec(text)) !== null) {
          let name = cleanExtractedName(match[0]);
          if (name.length > 2 && !names.includes(name) && 
              !/^(الرقم|اسم|نتائج|البحث|للرقم|الشهرة)$/.test(name)) {
            names.push(name);
          }
        }
      }
    });
    
  } catch (e) {
    console.error('خطأ في استخراج الأسماء من JSON:', e);
  }
  
  return [...new Set(names)]
    .filter(name => name.length > 2 && name.length < 30)
    .slice(0, 50);
}

function extractNamesFromResponse(html) {
  const names = [];
  
  // إزالة العلامات HTML
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  
  // نمط الأسماء مع أرقام
  const numberedPattern = /(\d+)\s*[-–—:]\s*([^\d\n,]+)/g;
  let match;
  while ((match = numberedPattern.exec(text)) !== null) {
    let name = cleanExtractedName(match[2]);
    if (name.length > 2 && !names.includes(name) && !/^\d+$/.test(name)) {
      names.push(name);
    }
  }
  
  // نمط الأسماء العربية
  const arabicPattern = /[\u0600-\u06FF]{2,}(?:\s+[\u0600-\u06FF]{2,}){0,3}/g;
  let arabicMatch;
  while ((arabicMatch = arabicPattern.exec(text)) !== null) {
    let name = cleanExtractedName(arabicMatch[0]);
    if (name.length > 2 && !names.includes(name) && 
        !/^(الرقم|اسم|نتائج|البحث|للرقم|الشهرة|السجلات|المكتشفة|الأكثر|شيوعاً|اليمن)$/.test(name) &&
        !/^[\d+\s]+$/.test(name)) {
      names.push(name);
    }
  }
  
  return [...new Set(names)].slice(0, 50);
}

function extractNamesAlternative(html) {
  const names = [];
  
  // استخراج من العلامات المحددة
  const patterns = [
    /<[^>]*name[^>]*>([^<]+)<\/[^>]*>/gi,
    /<[^>]*user[^>]*>([^<]+)<\/[^>]*>/gi,
    /<[^>]*contact[^>]*>([^<]+)<\/[^>]*>/gi,
    /<td[^>]*>([^<]+)<\/td>/gi,
    /<span[^>]*>([^<]+)<\/span>/gi,
    /<div[^>]*>([^<]+)<\/div>/gi
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let name = cleanExtractedName(match[1]);
      if (name.length > 2 && !names.includes(name) && 
          /[\u0600-\u06FF]/.test(name) &&
          !/^\d+$/.test(name) &&
          !/^(الرقم|اسم|نتائج|البحث|للرقم|الشهرة)$/.test(name)) {
        names.push(name);
      }
    }
  }
  
  // استخراج من النص العادي
  const text = html.replace(/<[^>]*>/g, ' ');
  const simplePattern = /(?:اسم|الاسم|name|user|contact)[:\s]+([^\n<,]+)/gi;
  let simpleMatch;
  while ((simpleMatch = simplePattern.exec(text)) !== null) {
    let name = cleanExtractedName(simpleMatch[1]);
    if (name.length > 2 && !names.includes(name) && /[\u0600-\u06FF]/.test(name)) {
      names.push(name);
    }
  }
  
  return [...new Set(names)].slice(0, 50);
}

function extractNamesAdvanced(html) {
  const names = [];
  
  // استخراج كل النصوص العربية
  const arabicText = html.replace(/<[^>]*>/g, ' ').replace(/[^\\u0600-\\u06FF\s]/g, ' ');
  const words = arabicText.split(/\s+/).filter(w => w.length > 2);
  
  // تجميع الأسماء المحتملة (2-4 كلمات متتالية)
  for (let i = 0; i < words.length - 1; i++) {
    // اسم مكون من كلمتين
    const twoWords = words[i] + ' ' + words[i+1];
    const cleanTwo = cleanExtractedName(twoWords);
    if (cleanTwo.length > 3 && cleanTwo.length < 30 && 
        !names.includes(cleanTwo) && 
        !/^(الرقم|اسم|نتائج|البحث|للرقم|الشهرة|السجلات|المكتشفة|الأكثر|شيوعاً|اليمن)$/.test(cleanTwo)) {
      names.push(cleanTwo);
    }
    
    // اسم مكون من ثلاث كلمات
    if (i < words.length - 2) {
      const threeWords = words[i] + ' ' + words[i+1] + ' ' + words[i+2];
      const cleanThree = cleanExtractedName(threeWords);
      if (cleanThree.length > 4 && cleanThree.length < 40 && 
          !names.includes(cleanThree) && 
          !/^(الرقم|اسم|نتائج|البحث|للرقم|الشهرة)$/.test(cleanThree)) {
        names.push(cleanThree);
      }
    }
  }
  
  return [...new Set(names)].slice(0, 50);
}

function cleanExtractedName(name) {
  return name
    .replace(/[\\{}{}\[\]"':\-_,\/()]/g, ' ')
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
console.log('✅ تم تحسين استخراج الأسماء');

Deno.serve({ port: 8000, hostname: "0.0.0.0" }, handler);
