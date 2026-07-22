// ==========================================================
// 📦 نظام التخزين المؤقت (Cache)
// ==========================================================
class MemoryCache {
  constructor() {
    this.cache = new Map();
    this.defaultTTL = 60; // دقيقة واحدة
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
const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY") || "";

// إنشاء مثيلات
const cache = new MemoryCache();
const rateLimiter = new RateLimiter();

// تنظيف دوري
setInterval(() => {
  cache.cleanup();
  rateLimiter.cleanup();
}, 60000);

console.log('🚀 جاري تشغيل الخادم على Deno Deploy...');
console.log(`🔥 Firecrawl API Key: ${FIRECRAWL_API_KEY ? '✅ موجود' : '❌ غير موجود'}`);

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
                'Cache-Control': 'public, max-age=60',
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
    // 🌐 [المستوى 3] جلب عبر Firecrawl 🔥
    // ==========================================================
    let names = [];
    let success = false;
    let lastError = null;
    let source = '';
    let rawData = null;

    if (FIRECRAWL_API_KEY) {
      console.log('🔥 استخدام Firecrawl...');
      
      try {
        const targetUrl = `https://3.nabx.net/wp-admin/admin-ajax.php?action=alosh_search&phone=${encodeURIComponent(scrapePhone)}`;
        console.log(`📡 جلب البيانات من: ${targetUrl}`);
        
        const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: targetUrl,
            formats: ['json', 'html'],
            waitFor: 5000,
            timeout: 30000
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          rawData = data;
          console.log('✅ استجابة Firecrawl مستلمة');
          
          // محاولة استخراج من JSON أولاً
          if (data.data && data.data.json) {
            const extractedNames = extractNamesFromJSONImproved(data.data.json);
            if (extractedNames.length > 0) {
              names = extractedNames;
              success = true;
              source = 'firecrawl_json';
              console.log(`✅ استخراج ${names.length} اسم من JSON`);
            }
          }
          
          // إذا فشل JSON، جرب HTML مع تحسينات
          if (!success || names.length === 0) {
            const htmlContent = data.data?.html || data.html || data.content || '';
            if (htmlContent && htmlContent.length >= 50) {
              const extractedNames = extractNamesFromHTMLImproved(htmlContent);
              if (extractedNames.length > 0) {
                names = extractedNames;
                success = true;
                source = 'firecrawl_html';
                console.log(`✅ استخراج ${names.length} اسم من HTML (محسن)`);
              }
            }
          }
        } else {
          const errorText = await response.text();
          console.log(`⚠️ فشل Firecrawl: ${response.status} - ${errorText}`);
          lastError = `Firecrawl error: ${response.status}`;
        }
      } catch (e) {
        console.error('❌ خطأ في Firecrawl:', e);
        lastError = `Firecrawl exception: ${e.message}`;
      }
    } else {
      console.log('⚠️ مفتاح Firecrawl غير موجود');
      lastError = 'مفتاح Firecrawl غير موجود';
    }

    // ==========================================================
    // 🔄 المحاولة البديلة: جلب مباشر
    // ==========================================================
    if (!success || names.length === 0) {
      console.log('🔄 محاولة الجلب المباشر...');
      
      try {
        const targetUrl = `https://3.nabx.net/wp-admin/admin-ajax.php?action=alosh_search&phone=${encodeURIComponent(scrapePhone)}`;
        
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
          
          if (contentType.includes('application/json')) {
            const jsonData = await response.json();
            rawData = jsonData;
            const extractedNames = extractNamesFromJSONImproved(jsonData);
            if (extractedNames.length > 0) {
              names = extractedNames;
              success = true;
              source = 'direct_json';
              console.log(`✅ استخراج ${names.length} اسم من JSON مباشر (محسن)`);
            }
          } else {
            const htmlContent = await response.text();
            if (htmlContent && htmlContent.length >= 50) {
              const extractedNames = extractNamesFromHTMLImproved(htmlContent);
              if (extractedNames.length > 0) {
                names = extractedNames;
                success = true;
                source = 'direct_scrape';
                console.log(`✅ استخراج ${names.length} اسم من HTML مباشر (محسن)`);
              }
            }
          }
        }
      } catch (e) {
        console.log(`⚠️ فشل الجلب المباشر: ${e.message}`);
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
        error: lastError || 'لم يتم العثور على نتائج',
        debug: {
          phone: scrapePhone,
          provider: provider,
          has_firecrawl_key: !!FIRECRAWL_API_KEY,
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
      source: source.includes('firecrawl') ? 'Firecrawl' : 'مباشر',
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
        'Cache-Control': 'public, max-age=60',
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
// 📝 دوال استخراج الأسماء المحسنة
// ==========================================================

function extractNamesFromJSONImproved(jsonData) {
  const names = [];
  
  try {
    // محاولة استخراج من جميع الحقول الممكنة
    const possibleFields = ['result', 'data', 'results', 'names', 'users', 'contacts', 'items'];
    
    for (const field of possibleFields) {
      if (jsonData[field]) {
        const text = typeof jsonData[field] === 'string' ? jsonData[field] : JSON.stringify(jsonData[field]);
        
        // استخراج الأسماء بتنسيقات مختلفة
        const patterns = [
          /اسم[\s_:]+([^\n,]+)/gi,
          /الاسم[\s_:]+([^\n,]+)/gi,
          /name[\s_:]+([^\n,]+)/gi,
          /full_name[\s_:]+([^\n,]+)/gi,
          /user[\s_:]+([^\n,]+)/gi,
          /contact[\s_:]+([^\n,]+)/gi,
          /(\d+)\s*[-–—]\s*([^\d\n,]+)/g,
          /([\u0600-\u06FF]{3,}(?:\s+[\u0600-\u06FF]{3,}){0,4})/g
        ];
        
        for (const pattern of patterns) {
          let match;
          while ((match = pattern.exec(text)) !== null) {
            let name = match[1] || match[2] || match[0];
            name = cleanExtractedNameImproved(name);
            if (name && name.length > 2 && !names.includes(name) && !/^\+?\d+$/.test(name) && !/^[0-9\s]+$/.test(name)) {
              names.push(name);
            }
          }
        }
        
        // إذا كان الحقل مصفوفة
        if (Array.isArray(jsonData[field])) {
          for (const item of jsonData[field]) {
            if (typeof item === 'string') {
              const cleaned = cleanExtractedNameImproved(item);
              if (cleaned && cleaned.length > 2 && !names.includes(cleaned) && /[\u0600-\u06FF]/.test(cleaned)) {
                names.push(cleaned);
              }
            } else if (typeof item === 'object' && item !== null) {
              for (const key of ['name', 'full_name', 'user', 'contact', 'username', 'title']) {
                if (item[key] && typeof item[key] === 'string') {
                  const cleaned = cleanExtractedNameImproved(item[key]);
                  if (cleaned && cleaned.length > 2 && !names.includes(cleaned) && /[\u0600-\u06FF]/.test(cleaned)) {
                    names.push(cleaned);
                  }
                }
              }
            }
          }
        }
      }
    }
    
    // البحث في النص ككل إذا كان jsonData.result موجود
    if (jsonData.result && typeof jsonData.result === 'string') {
      const text = jsonData.result;
      const allNames = text.match(/[\u0600-\u06FF]{3,}(?:\s+[\u0600-\u06FF]{3,}){0,4}/g);
      if (allNames) {
        for (const name of allNames) {
          const cleaned = cleanExtractedNameImproved(name);
          if (cleaned && cleaned.length > 2 && !names.includes(cleaned) && !/^\+?\d+$/.test(cleaned) && !/^[0-9\s]+$/.test(cleaned)) {
            names.push(cleaned);
          }
        }
      }
    }
    
  } catch (e) {
    console.error('خطأ في استخراج الأسماء من JSON:', e);
  }
  
  // إزالة التكرارات والتصفية
  return [...new Set(names)]
    .filter(name => name.length > 2 && name.length < 50 && /[\u0600-\u06FF]/.test(name))
    .slice(0, 50);
}

function extractNamesFromHTMLImproved(html) {
  const names = [];
  
  try {
    // إزالة الوسوم
    let text = html.replace(/<[^>]*>/g, ' ');
    text = text.replace(/\s+/g, ' ');
    
    // استخراج الأسماء بتنسيقات متعددة
    const patterns = [
      /اسم[\s_:]+([^\n,]+)/gi,
      /الاسم[\s_:]+([^\n,]+)/gi,
      /name[\s_:]+([^\n,]+)/gi,
      /full_name[\s_:]+([^\n,]+)/gi,
      /user[\s_:]+([^\n,]+)/gi,
      /contact[\s_:]+([^\n,]+)/gi,
      /(\d+)\s*[-–—]\s*([^\d\n,]+)/g,
      /([\u0600-\u06FF]{3,}(?:\s+[\u0600-\u06FF]{3,}){0,4})/g,
      /<[^>]*>([\u0600-\u06FF]{3,})[^<]*<\/[^>]*>/g
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        let name = match[1] || match[2] || match[0];
        name = cleanExtractedNameImproved(name);
        if (name && name.length > 2 && !names.includes(name) && !/^\+?\d+$/.test(name) && !/^[0-9\s]+$/.test(name)) {
          names.push(name);
        }
      }
    }
    
    // البحث عن الكلمات المفتاحية
    const keywords = ['صاحب', 'مالك', 'المستخدم', 'العميل', 'الشخص', 'الرقم'];
    for (const keyword of keywords) {
      const regex = new RegExp(`${keyword}[\\s:]+([^\\n,]+)`, 'gi');
      let match;
      while ((match = regex.exec(text)) !== null) {
        let name = match[1];
        name = cleanExtractedNameImproved(name);
        if (name && name.length > 2 && !names.includes(name) && /[\u0600-\u06FF]/.test(name)) {
          names.push(name);
        }
      }
    }
    
  } catch (e) {
    console.error('خطأ في استخراج الأسماء من HTML:', e);
  }
  
  // إزالة التكرارات والتصفية
  return [...new Set(names)]
    .filter(name => name.length > 2 && name.length < 50 && /[\u0600-\u06FF]/.test(name))
    .slice(0, 50);
}

function cleanExtractedNameImproved(name) {
  if (!name) return '';
  
  return name
    .replace(/[\\{}{}\[\]"':\-_,\/()]/g, ' ')
    .replace(/\b(info|country|n|null|undefined|الرقم|اسم|search|phone|نتائج|البحث|للرقم|الشهرة|السجلات|المكتشفة|الأكثر|شيوعاً|اليمن|من|هذا|هذه|كان|مع|عن|على|الى|حتى|بين|أو|و|ف|في|إلى|على|عن|من|إلى|عند|ب|ك|ل|لل|و|ثم|حتى|لكن|ولا|أو|ثم|حيث|بين|عندما|ذلك|هذه|هذا|التي|الذي|الذين|اللاتي|اللواتي|منذ|خلال|بسبب|دون|بينما|حيثما|كلما|متى|أين|كيف|إذا|لن|لم|ما|لا|ليس|سوف|قد|ربما|لعل|ليت|لابد|لعل|لكي|كي|حتّى|حتى|رقم|الهاتف|جوال|mobile|phone|number|هاتف|محمول|التحقق|النتيجة|نتيجة|البحث|عرض|تفاصيل|السجل|السجلات|المستخدم|العميل|الزبون|الشخص|المرسل|المستلم|المالك|صاحب)\b/gi, '')
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
// 🚀 تشغيل الخادم على Deno Deploy
// ==========================================================
console.log('🚀 تشغيل خادم Deno Deploy...');
console.log(`🔥 Firecrawl API Key: ${FIRECRAWL_API_KEY ? '✅ موجود' : '❌ غير موجود'}`);

// Deno Deploy يستخدم Deno.serve مباشرة
Deno.serve(handler);
