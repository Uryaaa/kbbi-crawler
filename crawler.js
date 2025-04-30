const puppeteer = require('puppeteer');
const fs = require('fs/promises');
const path = require('path'); // Added for path operations

const NUM_WORKERS = 11;
const RATE_LIMIT_MS = 200;
const WORD_LIST_FILE = 'indonesian-wordlist-sorted.txt';
const OUTPUT_FILE = 'kbbi_crawl_results.json';
const SAVE_INTERVAL = 50;

const extractDataFromPage = () => {
    const desc = document.querySelector('#desc');
    if (!desc) {
        const notFoundBody = document.querySelector('body > .container > p');
        if (notFoundBody && notFoundBody.textContent.toLowerCase().includes('tidak ditemukan')) {
            return { error: 'Entri tidak ditemukan' };
        }
        return null;
    }

    const notFoundDesc = desc.querySelector('h4');
    if (notFoundDesc && notFoundDesc.textContent.toLowerCase().includes('tidak ditemukan')) {
        return { error: 'Entri tidak ditemukan' };
    }

    const markerRegex = /^[:\s]/i;
    const subMarkerRegex = /^[:\s]/

    const kata = desc.querySelector('b.main')?.childNodes
        ? Array.from(desc.querySelector('b.main').childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.nodeValue.trim())
            .join('')
        : '';

    const pelafalan = desc.querySelector('.per-suku')?.textContent.trim() || '';
    const jenis = desc.querySelector('.per-suku + em.jk')?.getAttribute('title') || '';
    const pranala = desc.querySelector('#tdef a')?.href || null;

    const mainDefinitions = [];
    const d1 = document.querySelector('#d1');

    if (d1) {
        let currentNumber = '1';
        let currentArti = '';
        let collecting = false;
        let firstTextNode = true;
        let startIdx = 0;

        const nodes = Array.from(d1.childNodes);
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].nodeName === 'EM' && nodes[i].classList.contains('jk')) {
                startIdx = i + 1;
                collecting = true;
                break;
            }
        }

        for (let i = startIdx; i < nodes.length; i++) {
            const node = nodes[i];

            if (node.nodeName === 'B' && node.classList.contains('num')) {
                if (currentArti.trim()) {
                    mainDefinitions.push({ no: currentNumber, arti: currentArti.trim() });
                }
                currentNumber = node.textContent.trim();
                currentArti = '';
                firstTextNode = true;
            } else if (node.nodeName === 'DIV' && (node.classList.contains('sub_17') || node.querySelector('.sub_17'))) {
                break;
            } else if (collecting) {
                let text = '';

                if (node.nodeType === Node.TEXT_NODE) {
                    text = node.textContent.replace(/\n/g, ' ').trim();
                    if (firstTextNode && text) {
                        text = text.replace(markerRegex, '').trim();
                        firstTextNode = false;
                    }
                } else if (node.nodeName === 'EM' && !node.classList.contains('jk')) {
                    text = node.textContent.trim();
                } else if (node.nodeName === 'A') {
                    text = node.textContent.trim();
                }

                if (text) currentArti += text + ' ';
            }
        }

        if (currentArti.trim()) {
            mainDefinitions.push({ no: currentNumber, arti: currentArti.trim() });
        }

    } else {
        let arti = '', collecting = false, firstTextNode = true;
        for (const node of desc.childNodes) {
            if (node.nodeName === 'EM' && node.classList.contains('jk')) {
                collecting = true;
                continue;
            }
            if (!collecting) continue;
            if (node.nodeType === Node.TEXT_NODE) {
                let text = node.textContent.replace(/\n/g, ' ').trim();
                if (firstTextNode && text) {
                    text = text.replace(markerRegex, '').trim();
                    firstTextNode = false;
                }
                if (text) arti += text + ' ';
            }
             // Adjusted the break condition slightly to check nodeName first
            if ((node.nodeName === 'BR' || node.nodeName === 'DIV') && node.classList.contains('sub_17')) break;
        }
        if (arti.trim()) {
            mainDefinitions.push({ no: '1', arti: arti.trim() });
        } else if (kata && kata !== 'N/A') { // Avoid logging for genuinely empty pages
             // console.warn(`[Browser] No definition found structure for: ${kata}`); // Removed console.warn
        }
    }

    const subDefinitions = [];
    const subDiv = desc.querySelector('.sub_17');
    if (subDiv) {
        let bentuk = null;
        let arti = '';
        let first = true;

        for (const node of Array.from(subDiv.childNodes)) {
            if (node.nodeName === 'B' && node.classList.contains('mjk')) {
                if (bentuk && arti.trim()) {
                    subDefinitions.push({
                        bentuk,
                        arti: arti.trim().replace(/;\s*$/, '')
                    });
                }
                bentuk = node.textContent.trim();
                arti = '';
                first = true;
            } else if (bentuk) {
                let text = '';

                if (node.nodeType === Node.TEXT_NODE) {
                    text = node.textContent.replace(/\n/g, ' ').trim();
                    if (first && text) {
                        text = text.replace(subMarkerRegex, '').trim();
                        first = false;
                    }
                } else if (node.nodeName === 'EM' && !node.classList.contains('jk')) {
                    text = node.textContent.trim();
                } else if (node.nodeName === 'A') {
                    text = node.textContent.trim();
                }

                if (text) arti += text + ' ';
            }
        }

        if (bentuk && arti.trim()) {
            subDefinitions.push({
                bentuk,
                arti: arti.trim().replace(/;\s*$/, '')
            });
        }
    }

    const uniqueDefs = [];
    const seenNumbers = new Set();

    for (const def of mainDefinitions) {
        if (/^\d+$/.test(def.no) && !seenNumbers.has(def.no)) {
            seenNumbers.add(def.no);
            uniqueDefs.push(def);
        } else if (!/^\d+$/.test(def.no) && def.arti) {
             // Allow non-numbered definitions if they have content
            uniqueDefs.push(def);
        }
    }

     // Return null if core data like 'kata' is missing, unless it was an explicit 'not found' error
     if (!kata && !(resultData && resultData.error === 'Entri tidak ditemukan')) {
        return null;
    }


    return {
        pranala,
        kata: kata || 'N/A', // Ensure kata is never empty if we reach here
        pelafalan,
        jenis,
        definisi: uniqueDefs,
        turunan: subDefinitions
    };
};


async function scrapeWord(browser, word, workerId) {
    let page = null;
    console.log(`[Worker ${workerId}] Processing: ${word}`);
    let resultData = null;
    try {
        page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const url = `https://kbbi.web.id/${encodeURIComponent(word)}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        resultData = await page.evaluate(extractDataFromPage);

        if (resultData && resultData.error === 'Entri tidak ditemukan') {
            console.log(`[Worker ${workerId}] Word not found: ${word}`);
            resultData = { kata_input: word, error: 'Entri tidak ditemukan' };
        } else if (resultData && resultData.kata && resultData.kata !== 'N/A') {
             // Ensure kata_input is always added for successful scrapes
            resultData.kata_input = word;
            console.log(`[Worker ${workerId}] Success: ${word}`);
        } else {
             // Handle cases where evaluate returned null or invalid structure
            console.warn(`[Worker ${workerId}] Invalid structure or timeout for: ${word}`);
            resultData = { kata_input: word, error: 'Struktur data tidak valid, berubah, atau timeout' };
        }

    } catch (err) {
        console.error(`[Worker ${workerId}] Error scraping ${word}: ${err.message}`);
        resultData = { kata_input: word, error: err.message };
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (closeErr) {
                console.error(`[Worker ${workerId}] Error closing page for ${word}: ${closeErr.message}`);
            }
        }
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }
    return resultData;
}

async function saveResultsToFile(results, outputFile) {
    try {
        await fs.writeFile(outputFile, JSON.stringify(results, null, 2));
        console.log(`[Save] ${results.length} total entries saved to ${outputFile}`);
    } catch (err) {
        console.error('[Save Error] Could not write to file:', err.message);
    }
}

async function loadExistingResults(outputFile) {
    try {
        await fs.access(outputFile); // Check if file exists
        const data = await fs.readFile(outputFile, 'utf-8');
        if (!data) { // Handle empty file case
             console.log(`[Load] Output file ${outputFile} is empty. Starting fresh.`);
             return { results: [], processedWords: new Set() };
        }
        const results = JSON.parse(data);
        const processedWords = new Set(results.map(r => r.kata_input));
        console.log(`[Load] Resuming. Loaded ${results.length} existing entries. Found ${processedWords.size} unique words processed.`);
        return { results, processedWords };
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log(`[Load] Output file ${outputFile} not found. Starting fresh.`);
        } else {
            console.error(`[Load Error] Error reading or parsing ${outputFile}: ${err.message}. Starting fresh.`);
        }
        return { results: [], processedWords: new Set() }; // Return empty structure on error
    }
}


async function main() {
    let allWords = [];
    try {
        allWords = (await fs.readFile(WORD_LIST_FILE, 'utf-8')).split('\n').filter(Boolean);
        if (allWords.length === 0) {
             console.error(`Error: Word list file '${WORD_LIST_FILE}' is empty or could not be read properly.`);
             return;
        }
        console.log(`[Init] Loaded ${allWords.length} words from ${WORD_LIST_FILE}`);
    } catch (err) {
        console.error(`Error reading word list file '${WORD_LIST_FILE}': ${err.message}`);
        return; // Exit if word list cannot be read
    }


    const { results, processedWords } = await loadExistingResults(OUTPUT_FILE);

    const wordsToProcess = allWords.filter(word => !processedWords.has(word));
    const totalWordsToProcess = wordsToProcess.length;

    if (totalWordsToProcess === 0) {
        console.log("[Init] All words from the list have already been processed.");
        return; // Nothing new to do
    }

    console.log(`[Init] Starting crawl for ${totalWordsToProcess} new words.`);

    const browser = await puppeteer.launch({ headless: true });
    const promises = [];
    let wordIndex = 0; // Index for wordsToProcess array
    let processedCountSinceLastSave = 0; // Counter for saving interval

    for (let i = 0; i < NUM_WORKERS; i++) {
        promises.push((async function worker(id) {
            while (true) {
                const currentIndex = wordIndex++; // Get current index and increment for next worker
                if (currentIndex >= totalWordsToProcess) {
                    break; // No more words left for this worker
                }

                const word = wordsToProcess[currentIndex];
                const result = await scrapeWord(browser, word, id);

                 // Only push valid results (even errors) to maintain progress tracking
                 if (result) {
                    results.push(result);
                    processedCountSinceLastSave++;

                    // Save periodically based on newly processed items
                    if (processedCountSinceLastSave > 0 && processedCountSinceLastSave % SAVE_INTERVAL === 0) {
                         // Note: Saving the entire 'results' array including previously loaded ones
                        await saveResultsToFile(results, OUTPUT_FILE);
                    }
                 } else {
                    console.warn(`[Worker ${id}] Received null result for ${word}, skipping addition.`);
                 }
            }
        })(i + 1));
    }

    try {
        await Promise.all(promises);
    } catch(err) {
         console.error("[Main Error] Error during parallel processing:", err);
    } finally {
        console.log("[Main] All workers finished or encountered break point.");
        await saveResultsToFile(results, OUTPUT_FILE); // Final save
        await browser.close();
        console.log("[Main] Browser closed. Script finished.");
    }
}

main().catch(console.error);
