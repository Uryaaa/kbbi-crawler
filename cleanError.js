const fs = require('fs');


const rawData = fs.readFileSync('kbbi_crawl_results.json', 'utf8');
const data = JSON.parse(rawData);


if (!Array.isArray(data)) {
  console.error('Data dalam file.json harus berupa array.');
  process.exit(1);
}


const cleanedData = data.filter(item => !item.hasOwnProperty('error'));


fs.writeFileSync('cleaned.json', JSON.stringify(cleanedData, null, 2), 'utf8');

console.log('Data berhasil dibersihkan. Simpan di cleaned.json');
