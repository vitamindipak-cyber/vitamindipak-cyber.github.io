const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse-fork');

// फोल्डरको पाथहरू (card_form_reviewed/laws र card_form_reviewed/laws_database.json)
const LAWS_FOLDER = path.join(__dirname, 'laws');
const OUTPUT_JSON_FILE = path.join(__dirname, 'laws_database.json');

async function convertPDFsToJSON() {
    console.log("==================================================");
    console.log("🔄 PDF To JSON कन्भर्टर स्क्रिप्ट सुरु भयो...");
    console.log("==================================================");
    
    const jsonDatabase = [];

    try {
        // १. फोल्डर छ कि छैन पक्का गर्ने
        if (!fs.existsSync(LAWS_FOLDER)) {
            console.error(`❌ त्रुटि: '${LAWS_FOLDER}' फोल्डर फेला परेन। कृपया आफ्नो PDF हरू यही फोल्डर भित्र राख्नुहोस्।`);
            return;
        }

        const files = fs.readdirSync(LAWS_FOLDER);
        const pdfFiles = files.filter(file => path.extname(file).toLowerCase() === '.pdf');
        
        console.log(`📂 जम्मा फेला परेका PDF फाइलहरू: ${pdfFiles.length} वटा`);

        if (pdfFiles.length === 0) {
            console.log("⚠️ चेतावनी: 'laws' फोल्डर खाली छ। कृपया PDF फाइलहरू राखेर फेरि चलाउनुहोस्।");
            return;
        }

        let count = 1;
        for (const file of pdfFiles) {
            console.log(`[${count}/${pdfFiles.length}] ⏳ प्रोसेस हुँदैछ: ${file}...`);
            
            const filePath = path.join(LAWS_FOLDER, file);
            
            try {
                const dataBuffer = fs.readFileSync(filePath);
                
                // PDF बाट टेक्स्ट निकाल्ने
                const pdfData = await pdfParse(dataBuffer);
                
                // अनावश्यक खाली ठाउँहरू सफा गर्ने
                const cleanText = pdfData.text.replace(/\s+/g, ' ').trim();

                jsonDatabase.push({
                    id: count,
                    lawName: path.basename(file, '.pdf'),
                    fullText: cleanText
                });

                console.log(`   ✓ सफलता: ${file} कन्भर्ट भयो।`);
                count++;
            } catch (pdfError) {
                console.error(`   ❌ यो फाइल पढ्न सकिएन: ${file} | कारण: ${pdfError.message}`);
            }
        }

        // २. JSON फाइलमा केरमेट नगरी सेभ गर्ने
        console.log("\n💾 JSON फाइल लेख्दै, कृपया केही सेकेन्ड पर्खनुहोस्...");
        fs.writeFileSync(OUTPUT_JSON_FILE, JSON.stringify(jsonDatabase, null, 2), 'utf8');
        
        console.log("==================================================");
        console.log(`🎉 सफलतापूर्वक 'laws_database.json' तयार भयो!`);
        console.log(`📍 फाइल पाथ: ${OUTPUT_JSON_FILE}`);
        console.log("==================================================");
        console.log("💡 अब तपाईं 'laws' फोल्डर र भित्रका PDF हरू DELETE गर्न सक्नुहुन्छ।");

    } catch (error) {
        console.error("❌ मुख्य प्रोसेसमा प्राविधिक त्रुटि आयो:", error);
    }
}

// फंक्सनलाई रन गर्ने (कल गर्ने)
convertPDFsToJSON().catch(err => {
    console.error("❌ स्क्रिप्ट रन गर्दा समस्या आयो:", err);
});