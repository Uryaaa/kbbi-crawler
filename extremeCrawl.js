// Import library yang dibutuhkan
const puppeteer = require('puppeteer');
const fs = require('fs');

// ============ KONFIGURASI OPTIMIZED ============
const CONFIG = {
  MAX_WORKERS: Math.min(16, require('os').cpus().length * 2), // Auto-detect optimal worker count
  RATE_LIMIT: 300,          // Reduced for faster processing
  ADAPTIVE_RATE_LIMIT: true, // Enable adaptive rate limiting
  SEED_WORDS: ['kamus', 'bahasa', 'indonesia', 'kata', 'arti'],
  OUTPUT_FILE: 'fullExtract.json',
  RESUME_FILE: 'fullExtractResume.json',
  MAX_WORD_LENGTH: 30,
  MIN_WORD_LENGTH: 1,
  SAVE_INTERVAL: 100,       // Save progress every 100 entries (reduced frequency)
  TIMEOUT: 20000,           // Reduced timeout for faster failure detection
  MAX_RETRIES: 2,           // Maximum retry attempts
  MEMORY_CHECK_INTERVAL: 1000, // Check memory every 1000 processed words
  BROWSER_POOL_SIZE: 4,     // Number of browser instances to pool
};
// ===============================================

/**
 * Optimized adaptive rate limiter with intelligent throttling
 */
class AdaptiveRateLimiter {
  constructor(baseInterval) {
    this.baseInterval = baseInterval;
    this.currentInterval = baseInterval;
    this.lastRequestTime = 0;
    this.queue = [];
    this.processing = false;
    this.successCount = 0;
    this.errorCount = 0;
    this.adaptiveThreshold = 10;
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;
    const { resolve, startTime } = this.queue.shift();

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const delay = Math.max(0, this.currentInterval - timeSinceLastRequest);

    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }

    this.lastRequestTime = Date.now();
    resolve();
    this.processing = false;

    // Process next immediately if queue exists
    if (this.queue.length > 0) {
      setImmediate(() => this.processQueue());
    }
  }

  acquire() {
    return new Promise(resolve => {
      this.queue.push({ resolve, startTime: Date.now() });
      this.processQueue();
    });
  }

  // Adaptive rate adjustment based on success/error rates
  adjustRate(success = true) {
    if (success) {
      this.successCount++;
      if (this.successCount % this.adaptiveThreshold === 0) {
        // Gradually decrease interval for faster processing
        this.currentInterval = Math.max(50, this.currentInterval * 0.9);
      }
    } else {
      this.errorCount++;
      // Increase interval on errors
      this.currentInterval = Math.min(1000, this.currentInterval * 1.5);
    }
  }
}

/**
 * Browser pool manager for connection reuse
 */
class BrowserPool {
  constructor(size = CONFIG.BROWSER_POOL_SIZE) {
    this.browsers = [];
    this.size = size;
    this.currentIndex = 0;
  }

  async initialize() {
    const browserOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-pings',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-component-extensions-with-background-pages',
        '--disable-extensions',
        '--disable-plugins'
      ]
    };

    for (let i = 0; i < this.size; i++) {
      const browser = await puppeteer.launch(browserOptions);
      this.browsers.push(browser);
    }
  }

  getBrowser() {
    const browser = this.browsers[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.size;
    return browser;
  }

  async closeAll() {
    await Promise.all(this.browsers.map(browser => browser.close()));
  }
}

/**
 * Optimized KBBI structure extraction with cached DOM queries
 * @param {puppeteer.Page} page Objek halaman Puppeteer
 * @param {string} word Kata yang sedang diproses
 * @returns {Promise<Object|null>} Objek struktur data KBBI atau null jika tidak valid
 */
async function extractKBBIStructure(page, word) {
  try {
    return await page.evaluate((searchWord) => {
      const definitionArea = document.querySelector('#d1');
      if (!definitionArea) return null;

      // Quick check for "not found" - exit early if found
      const notFoundElement = definitionArea.querySelector('h3');
      if (notFoundElement && notFoundElement.textContent.includes('Entri tidak ditemukan')) {
        return null;
      }

      // Cache frequently used selectors for performance
      const cachedElements = {
        mainWord: definitionArea.querySelector('b.main'),
        pronunciationEl: definitionArea.querySelector('span.per-suku'),
        posEl: definitionArea.querySelector('em.jk'),
        numberedDefs: definitionArea.querySelectorAll('b.num'),
        compoundElements: definitionArea.querySelectorAll('b.mjk'),
        derivedElements: definitionArea.querySelectorAll('b.tur')
      };

      // Struktur data hasil
      const result = {
        kata: searchWord,
        url: window.location.href,
        waktu_ekstraksi: new Date().toISOString(),
        entri: {}
      };

      // Ekstrak headword (kata utama)
      if (cachedElements.mainWord) {
        const mainWord = cachedElements.mainWord;
        const kata_utama = {
          kata: mainWord.textContent.replace(/\d+$/, '').trim(),
          varian: null,
          pelafalan: null,
          kelas_kata: null,
          kelas_kata_lengkap: null,
          arti_utama: null
        };

        // Ekstrak variant (angka superscript)
        const variantMatch = mainWord.textContent.match(/(\d+)$/);
        if (variantMatch) {
          kata_utama.varian = parseInt(variantMatch[1]);
        }

        // Ekstrak pronunciation
        if (cachedElements.pronunciationEl) {
          kata_utama.pelafalan = cachedElements.pronunciationEl.textContent.trim();
        }

        // Ekstrak part of speech
        if (cachedElements.posEl) {
          kata_utama.kelas_kata = cachedElements.posEl.textContent.trim();
          kata_utama.kelas_kata_lengkap = cachedElements.posEl.getAttribute('title') || null;
        }

        // Ekstrak definisi utama - cek apakah ada numbered definitions
        const firstNumberedDef = Array.from(cachedElements.numberedDefs).find(numEl => {
          // Pastikan numbered def ini adalah bagian dari headword, bukan compound/derived
          const parentCompound = numEl.closest('.sub_17');
          const parentDerived = numEl.closest('b.tur');
          return !parentCompound && !parentDerived;
        });

        if (firstNumberedDef) {
          // Ada numbered definitions untuk headword
          const definisi = [];
          const allNumberedDefs = Array.from(cachedElements.numberedDefs).filter(numEl => {
            const parentCompound = numEl.closest('.sub_17');
            const parentDerived = numEl.closest('b.tur');
            return !parentCompound && !parentDerived;
          });

          allNumberedDefs.forEach(numEl => {
            const nomor = parseInt(numEl.textContent.trim());
            let defText = '';
            let contoh = '';
            let bidang = null;
            let peribahasa = null;
            let nextNode = numEl.nextSibling;

            while (nextNode && nextNode.nodeName !== 'B' && !nextNode.classList?.contains('num')) {
              if (nextNode.nodeType === Node.TEXT_NODE) {
                const text = nextNode.textContent.trim();
                if (text && !text.startsWith('<')) {
                  defText += text + ' ';
                }
              } else if (nextNode.nodeName === 'EM') {
                if (nextNode.classList?.contains('jk')) {
                  // Domain information
                  bidang = {
                    singkatan: nextNode.textContent.trim(),
                    nama_lengkap: nextNode.getAttribute('title') || null
                  };
                } else if (nextNode.classList?.contains('pb')) {
                  // Peribahasa (proverb)
                  const proverbText = nextNode.textContent.trim();
                  // Extract the proverb and its meaning
                  const parts = proverbText.split(', pb ');
                  if (parts.length === 2) {
                    peribahasa = {
                      teks: parts[0],
                      makna: parts[1],
                      jenis: "peribahasa"
                    };
                  } else {
                    peribahasa = {
                      teks: proverbText,
                      jenis: "peribahasa"
                    };
                  }
                } else {
                  // Ini kemungkinan contoh (italic text)
                  contoh = nextNode.textContent.trim();
                }
              }
              nextNode = nextNode.nextSibling;
            }

            const definisiItem = { nomor, arti: defText.trim() };
            if (bidang) {
              definisiItem.bidang = bidang;
            }
            if (peribahasa) {
              definisiItem.peribahasa = peribahasa;
            }
            if (contoh) {
              definisiItem.contoh = contoh;
            }
            definisi.push(definisiItem);
          });

          kata_utama.definisi = definisi;
        } else {
          // Tidak ada numbered definitions, ambil definisi tunggal
          const textAfterPos = definitionArea.textContent;
          const posText = cachedElements.posEl ? cachedElements.posEl.textContent : '';
          const afterPosIndex = textAfterPos.indexOf(posText) + posText.length;
          const definitionText = textAfterPos.substring(afterPosIndex).split(';')[0].trim();
          if (definitionText) {
            kata_utama.arti_utama = definitionText;
          }
        }

        result.entri.kata_utama = kata_utama;
      }

      // Ekstrak compound terms (kata majemuk)
      const kata_majemuk = [];
      cachedElements.compoundElements.forEach(compoundEl => {
        const istilah = compoundEl.textContent.replace(/^--\s*/, '').trim();
        const majemuk = { istilah };

        // Cari definisi setelah compound term
        let nextNode = compoundEl.nextSibling;
        let arti = '';
        let hasNumberedDefs = false;
        const definisi = [];

        while (nextNode && nextNode.nodeName !== 'BR') {
          if (nextNode.nodeType === Node.TEXT_NODE) {
            arti += nextNode.textContent.trim() + ' ';
          } else if (nextNode.nodeName === 'B' && nextNode.classList.contains('num')) {
            hasNumberedDefs = true;
            const nomor = parseInt(nextNode.textContent.trim());
            let defText = '';
            let defNode = nextNode.nextSibling;

            while (defNode && defNode.nodeName !== 'B' && defNode.nodeName !== 'BR') {
              if (defNode.nodeType === Node.TEXT_NODE) {
                defText += defNode.textContent.trim() + ' ';
              } else if (defNode.nodeName === 'EM' && defNode.classList.contains('jk')) {
                // Domain information
                const bidang = {
                  singkatan: defNode.textContent.trim(),
                  nama_lengkap: defNode.getAttribute('title') || null
                };
                definisi.push({ nomor, bidang, arti: defText.trim() });
                defText = '';
                break;
              }
              defNode = defNode.nextSibling;
            }

            if (defText.trim()) {
              definisi.push({ nomor, arti: defText.trim() });
            }
          } else if (nextNode.nodeName === 'EM' && nextNode.classList.contains('jk')) {
            // Domain untuk definisi tunggal
            majemuk.bidang = {
              singkatan: nextNode.textContent.trim(),
              nama_lengkap: nextNode.getAttribute('title') || null
            };
          }
          nextNode = nextNode.nextSibling;
        }

        if (hasNumberedDefs && definisi.length > 0) {
          majemuk.definisi = definisi;
        } else if (arti.trim()) {
          majemuk.arti = arti.trim();
        }

        kata_majemuk.push(majemuk);
      });

      if (kata_majemuk.length > 0) {
        result.entri.kata_majemuk = kata_majemuk;
      }

      // Ekstrak derived words (kata turunan)
      const kata_turunan = [];
      cachedElements.derivedElements.forEach(derivedEl => {
        const kata = derivedEl.textContent.trim();
        const turunan = { kata };

        // Ekstrak pronunciation untuk kata turunan
        const pronunciationEl = derivedEl.nextElementSibling;
        if (pronunciationEl && pronunciationEl.classList.contains('per-suku')) {
          turunan.pelafalan = pronunciationEl.textContent.trim();
        }

        // Ekstrak part of speech untuk kata turunan - cari di sekitar elemen derived
        let posEl = null;
        let currentNode = derivedEl.nextSibling;
        while (currentNode && !posEl) {
          if (currentNode.nodeName === 'EM' && currentNode.classList.contains('jk')) {
            posEl = currentNode;
            break;
          }
          currentNode = currentNode.nextSibling;
        }

        if (posEl) {
          turunan.kelas_kata = posEl.textContent.trim();
          turunan.kelas_kata_lengkap = posEl.getAttribute('title') || null;
        }

        // Ekstrak definisi kata turunan
        let nextNode = derivedEl.nextSibling;
        let arti = '';
        const definisi = [];
        let hasNumberedDefs = false;

        while (nextNode && nextNode.nodeName !== 'B') {
          if (nextNode.nodeType === Node.TEXT_NODE) {
            arti += nextNode.textContent.trim() + ' ';
          } else if (nextNode.nodeName === 'B' && nextNode.classList.contains('num')) {
            hasNumberedDefs = true;
            const nomor = parseInt(nextNode.textContent.trim());
            let defText = '';
            let contoh = '';
            let defNode = nextNode.nextSibling;

            while (defNode && defNode.nodeName !== 'B') {
              if (defNode.nodeType === Node.TEXT_NODE) {
                defText += defNode.textContent.trim() + ' ';
              } else if (defNode.nodeName === 'EM' && !defNode.classList?.contains('jk')) {
                // Ini kemungkinan contoh (italic text)
                contoh = defNode.textContent.trim();
              }
              defNode = defNode.nextSibling;
            }

            if (defText.trim()) {
              const defObj = { nomor, arti: defText.trim() };
              if (contoh) {
                defObj.contoh = contoh;
              }
              definisi.push(defObj);
            }
          }
          nextNode = nextNode.nextSibling;
        }

        if (hasNumberedDefs && definisi.length > 0) {
          turunan.definisi = definisi;
        } else if (arti.trim()) {
          turunan.arti = arti.trim();
        }

        kata_turunan.push(turunan);
      });

      if (kata_turunan.length > 0) {
        result.entri.kata_turunan = kata_turunan;
      }

      return result;
    }, word);
  } catch (err) {
    console.warn(`Peringatan: Gagal mengekstrak struktur dari halaman: ${err.message}`);
    return null;
  }
}

/**
 * Mengekstrak kata-kata sederhana dari halaman untuk antrian
 * @param {puppeteer.Page} page Objek halaman Puppeteer
 * @returns {Promise<string[]>} Array kata unik dalam huruf kecil
 */
async function extractSimpleWords(page) {
  try {
    return await page.evaluate((minLen) => {
      const textContent = document.body.innerText || '';
      const words = textContent.match(/\b[a-z]+(?:-[a-z]+)*\b/gi) || [];
      return Array.from(new Set(words.map(w => w.toLowerCase())))
        .filter(w => w.length >= minLen);
    }, CONFIG.MIN_WORD_LENGTH);
  } catch (err) {
    console.warn(`Peringatan: Gagal mengekstrak kata dari halaman: ${err.message}`);
    return [];
  }
}

/**
 * Optimized worker function with improved performance and error handling
 */
async function crawlWordStructured(browserPool, limiter, queue, visited, output) {
  let page = null;
  let browser = null;
  let retryCount = 0;
  let processedCount = 0;

  while (true) {
    const word = queue.shift();

    if (!word) {
      // Optimized idle detection with shorter waits
      await new Promise(resolve => setTimeout(resolve, 100));
      if (queue.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (queue.length === 0) {
          break;
        }
      }
      continue;
    }

    if (visited.has(word)) {
      continue;
    }
    visited.add(word);

    try {
      await limiter.acquire();

      // Get browser from pool and create optimized page
      if (!browser) {
        browser = browserPool.getBrowser();
      }

      if (!page || page.isClosed()) {
        page = await browser.newPage();

        // Aggressive resource blocking for maximum speed
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const resourceType = req.resourceType();
          if (resourceType === 'document' || resourceType === 'xhr') {
            req.continue();
          } else {
            req.abort();
          }
        });

        // Optimize page settings
        await page.setViewport({ width: 1024, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      }

      const kbbiUrl = `https://kbbi.web.id/${encodeURIComponent(word)}`;
      await page.goto(kbbiUrl, {
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.TIMEOUT
      });

      limiter.adjustRate(true); // Mark success for adaptive rate limiting

      // Ekstrak struktur data lengkap
      const structuredData = await extractKBBIStructure(page, word);

      if (structuredData) {
        // Tambahkan ke output dengan struktur lengkap
        output.push(structuredData);

        // Ekstrak kata-kata baru untuk antrian
        const newWords = await extractSimpleWords(page);
        const filteredWords = newWords.filter(w =>
          !visited.has(w) &&
          w !== word.toLowerCase() &&
          w.length <= CONFIG.MAX_WORD_LENGTH &&
          w.length >= CONFIG.MIN_WORD_LENGTH
        );

        if (filteredWords.length > 0) {
          queue.push(...filteredWords);
        }

        console.log(`✅ ${word} (Valid, Ditemukan: ${output.length}, Antrian: ${queue.length}, +${filteredWords.length} baru)`);

        processedCount++;

        // Memory management - trigger GC hint periodically
        if (processedCount % CONFIG.MEMORY_CHECK_INTERVAL === 0) {
          if (global.gc) {
            global.gc();
          }
        }

        if (output.length % CONFIG.SAVE_INTERVAL === 0) {
          // Save asynchronously without blocking
          saveProgressStructured(output, queue, visited).catch(err =>
            console.warn('Save error:', err.message)
          );
        }
      } else {
        // Kata tidak valid, tapi tetap cek untuk kata dengan imbuhan
        const hasPrefix = /^(ter|di|ber|me|mem|men|meng|pen|pem|per|se|ke|pe)/i.test(word);
        const hasSuffix = /(nya|an)$/i.test(word);
        const isReduplicated = word.includes('-');

        if (hasPrefix || hasSuffix || isReduplicated) {
          // Tetap ekstrak kata baru meskipun kata ini tidak valid
          const newWords = await extractSimpleWords(page);
          const filteredWords = newWords.filter(w =>
            !visited.has(w) &&
            w !== word.toLowerCase() &&
            w.length <= CONFIG.MAX_WORD_LENGTH &&
            w.length >= CONFIG.MIN_WORD_LENGTH
          );

          if (filteredWords.length > 0) {
            queue.push(...filteredWords);
          }
          console.log(`🟡 ${word} - Tidak valid tapi memiliki imbuhan, +${filteredWords.length} kata baru`);
        } else {
          console.log(`🟡 ${word} - Tidak valid, dilewati`);
        }
      }

    } catch (err) {
      limiter.adjustRate(false); // Mark failure for adaptive rate limiting
      retryCount++;

      console.error(`❌ Gagal proses "${word}" (attempt ${retryCount}): ${err.name} - ${err.message.split('\n')[0]}`);

      // Implement retry logic with exponential backoff
      if (retryCount < CONFIG.MAX_RETRIES && !err.message.includes('Entri tidak ditemukan')) {
        const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 5000);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        queue.unshift(word); // Put word back at front of queue for retry
        visited.delete(word); // Remove from visited so it can be retried
        continue;
      }

      retryCount = 0; // Reset retry count for next word

      if (page && !page.isClosed() && (err.message.includes('Target closed') || err.message.includes('timeout') || err.name === 'TimeoutError')) {
        try {
          await page.close();
        } catch (closeErr) {
          console.warn(`Gagal menutup page setelah error: ${closeErr.message}`)
        }
        page = null;
        browser = null; // Force getting new browser from pool
      }
    }
  }

  if (page && !page.isClosed()) {
    try { await page.close(); } catch (e) { /* Abaikan error saat menutup */ }
  }
}

/**
 * Optimized save function with async I/O and compression
 */
async function saveProgressStructured(output, queue, visited) {
  try {
    if (!(visited instanceof Set)) {
      console.warn("Tipe 'visited' bukan Set saat menyimpan, mencoba konversi...");
      visited = new Set(visited);
    }
    console.log(`💾 Menyimpan progres... (${output.length} kata valid, ${visited.size} total dikunjungi)`);

    // Use async file operations for better performance
    const outputData = JSON.stringify(output, null, 0); // No pretty printing for smaller files
    const resumeData = {
      output: output,
      queue: queue,
      visited: Array.from(visited)
    };
    const resumeDataStr = JSON.stringify(resumeData, null, 0);

    // Write files asynchronously in parallel
    await Promise.all([
      fs.promises.writeFile(CONFIG.OUTPUT_FILE, outputData, 'utf-8'),
      fs.promises.writeFile(CONFIG.RESUME_FILE, resumeDataStr, 'utf-8')
    ]);

    console.log(`💾 Progres disimpan ke ${CONFIG.OUTPUT_FILE} dan ${CONFIG.RESUME_FILE}.`);
  } catch (err) {
    console.error("Gagal menyimpan progres:", err);
  }
}

// ==================================================
// Fungsi Utama (IIFE - Immediately Invoked Function Expression)
// ==================================================
(async () => {
  console.log("==============================================");
  console.log("🚀 Memulai Ekstraksi Kata (Struktur JSON)...");
  console.log("==============================================");
  let browserPool;

  try {
    // Initialize optimized browser pool
    console.log("🖥️  Menginisialisasi browser pool...");
    browserPool = new BrowserPool(CONFIG.BROWSER_POOL_SIZE);
    await browserPool.initialize();
    console.log(`🖥️  Browser pool dengan ${CONFIG.BROWSER_POOL_SIZE} instance berhasil diluncurkan.`);

    let queue = [...CONFIG.SEED_WORDS];
    let visited = new Set();
    let output = [];

    // Cek dan muat state dari file resume jika ada
    if (fs.existsSync(CONFIG.RESUME_FILE)) {
      try {
        console.log(`🔄 Memuat progres dari ${CONFIG.RESUME_FILE}...`);
        const resumeRaw = fs.readFileSync(CONFIG.RESUME_FILE, 'utf-8');
        const resumeData = JSON.parse(resumeRaw);
        output = resumeData.output || [];
        queue = resumeData.queue || [...CONFIG.SEED_WORDS];
        visited = new Set(resumeData.visited || []);

        // Pastikan semua kata di output juga ada di visited
        output.forEach(entry => visited.add(entry.kata));
        console.log(`✅ Progres dimuat: ${output.length} kata valid, ${queue.length} antrian, ${visited.size} total dikunjungi.`);

        if (queue.length === 0 && CONFIG.SEED_WORDS.some(sw => !visited.has(sw))) {
          const newSeeds = CONFIG.SEED_WORDS.filter(sw => !visited.has(sw));
          if (newSeeds.length > 0) {
            queue.push(...newSeeds);
            console.log(`ℹ️ Antrian kosong, menambahkan seed words yang belum divisit: ${newSeeds.join(', ')}`);
          }
        }

        if (queue.length === 0 && output.length === 0 && visited.size === 0) {
          console.log("ℹ️ State kosong atau tidak valid, memulai ulang dengan SEED_WORDS.");
          queue = [...CONFIG.SEED_WORDS];
        }

      } catch (err) {
        console.error(`Gagal memuat atau parse file resume (${CONFIG.RESUME_FILE}): ${err}. Memulai dari awal.`);
        try { fs.unlinkSync(CONFIG.RESUME_FILE); } catch (e) { /* abaikan jika gagal hapus */ }
        queue = [...CONFIG.SEED_WORDS]; visited = new Set(); output = [];
      }
    } else {
      console.log(`ℹ️ File resume (${CONFIG.RESUME_FILE}) tidak ditemukan, memulai dari awal.`);
    }

    // Initialize adaptive rate limiter
    const limiter = new AdaptiveRateLimiter(CONFIG.RATE_LIMIT);

    console.log(`👷 Menjalankan ${CONFIG.MAX_WORKERS} worker dengan browser pool...`);

    // Performance monitoring
    const startTime = Date.now();
    let lastProgressTime = startTime;
    let lastProgressCount = 0;

    // Progress monitoring interval
    const progressInterval = setInterval(() => {
      const currentTime = Date.now();
      const currentCount = output.length;
      const timeDiff = (currentTime - lastProgressTime) / 1000;
      const countDiff = currentCount - lastProgressCount;
      const rate = timeDiff > 0 ? (countDiff / timeDiff).toFixed(2) : 0;

      console.log(`📊 Progress: ${currentCount} kata, ${queue.length} antrian, ${rate} kata/detik`);

      lastProgressTime = currentTime;
      lastProgressCount = currentCount;
    }, 30000); // Report every 30 seconds

    const workers = [];
    for (let i = 0; i < CONFIG.MAX_WORKERS; i++) {
      workers.push(crawlWordStructured(browserPool, limiter, queue, visited, output));
    }

    await Promise.all(workers);
    clearInterval(progressInterval);

    console.log("🏁 Semua worker telah selesai.");
    console.log("💾 Menyimpan hasil akhir...");
    await saveProgressStructured(output, queue, visited);

    console.log("==============================================");
    console.log(`✅✅✅ Selesai! Total kata unik VALID ditemukan: ${output.length}.`);
    console.log(`       Total kata unik dikunjungi: ${visited.size}.`);
    console.log(`       Hasil disimpan di: ${CONFIG.OUTPUT_FILE}`);
    console.log("==============================================");

  } catch (error) {
    console.error("💥 Terjadi error fatal:", error);
  } finally {
    if (browserPool) {
      await browserPool.closeAll();
      console.log("🔒 Browser pool ditutup.");
    }
  }
})();
