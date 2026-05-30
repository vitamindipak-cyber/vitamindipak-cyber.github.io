const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// laws_database.json मात्र प्रयोग गरिन्छ - nepal-laws-catalog.js हटाइएको छ

const app = express();
const PORT = 3000;

app.use(express.json());

// Static files serve गर्ने
app.use(express.static(__dirname));

// CORS Middleware थप गरिएको छ ताकि फ्रन्टइन्डले बिना रोकटोक कल गर्न सकोस्
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    res.setHeader('Access-Control-Allow-Credentials', true);
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// यहाँ आफ्नो Gemini API Key वा Environment Variable राख्नुहोस्
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "AIzaSyDiZEx3QEQV8DR0ekGb1aCzCZBpqu9N-Co";
const genAI = new GoogleGenerativeAI(API_KEY);

// PDF को साटो सिधै नयाँ JSON फाइलको पाथ राख्ने
const JSON_DB_PATH = path.join(__dirname, 'laws_database.json');
let lawsDatabase = [];

function normalizeSearchText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[\u200c\u200d]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getLawSearchableText(law) {
    if (!law) return '';
    if (law.fullText) return String(law.fullText);
    if (law.text) return String(law.text);
    if (Array.isArray(law.sections) && law.sections.length) {
        return law.sections.map((sec) =>
            `${sec.section_no || ''} ${sec.title || ''} ${sec.content || ''}`
        ).join(' ');
    }
    return '';
}

function scoreLawRelevance(text, law) {
    const hay = normalizeSearchText(text);
    if (!hay || !law) return 0;
    const name = normalizeSearchText(law.lawName || law.name || '');
    const full = normalizeSearchText(getLawSearchableText(law));
    let score = 0;
    if (name && hay.includes(name)) score += 50;
    const keywords = hay.split(/\s+/).filter((k) => k.length >= 2);
    keywords.forEach((k) => {
        if (name.includes(k)) score += 4;
        if (full.includes(k)) score += 1;
    });
    if (full.length > 20 && hay.length > 8) {
        const probe = hay.slice(0, Math.min(24, hay.length));
        if (full.includes(probe)) score += 12;
    }
    return score;
}

function scoreSectionRelevance(complaint, section, lawScore) {
    const hay = normalizeSearchText(complaint);
    const block = normalizeSearchText(
        `${section.section_no || ''} ${section.title || ''} ${section.content || ''}`
    );
    if (!hay || !block) return 0;
    let score = Math.floor((lawScore || 0) / 15);
    const keywords = hay.split(/\s+/).filter((k) => k.length >= 2);
    keywords.forEach((k) => {
        if (block.includes(k)) score += 2;
    });
    const title = normalizeSearchText(section.title || '');
    if (title && hay.includes(title.slice(0, Math.min(title.length, 12)))) score += 6;
    return score;
}

function buildSuggestedLawsFromDatabase(complaint, limit = 5) {
    const results = [];
    lawsDatabase.forEach((law) => {
        const lawName = String(law.lawName || law.name || '').trim();
        if (!lawName) return;
        const lawScore = scoreLawRelevance(complaint, law);
        if (Array.isArray(law.sections) && law.sections.length) {
            law.sections.forEach((sec) => {
                const secScore = scoreSectionRelevance(complaint, sec, lawScore);
                if (secScore < 3) return;
                const sectionLabel = sec.section_no
                    ? `दफा ${sec.section_no}${sec.title ? ' — ' + sec.title : ''}`
                    : (sec.title || 'सम्बन्धित प्रावधान');
                const content = String(sec.content || '').trim();
                results.push({
                    name: lawName,
                    section: sectionLabel,
                    description: content
                        ? content.slice(0, 300) + (content.length > 300 ? '…' : '')
                        : 'उजुरीको बेहोरासँग सम्बन्धित प्रावधान।',
                    score: secScore
                });
            });
        } else if (lawScore >= 4) {
            const excerpt = getLawSearchableText(law).trim();
            results.push({
                name: lawName,
                section: 'सम्बन्धित प्रावधान',
                description: excerpt
                    ? excerpt.slice(0, 300) + (excerpt.length > 300 ? '…' : '')
                    : 'उजुरीको बेहोरासँग सम्बन्धित ऐन/नियम।',
                score: lawScore
            });
        }
    });
    return results.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
}

function inferCategoryFromComplaint(complaint, suggestedLaws) {
    const hay = normalizeSearchText(complaint);
    const top = (suggestedLaws && suggestedLaws[0]) ? suggestedLaws[0] : null;
    const topName = top ? normalizeSearchText(top.name || '') : '';

    if (topName.includes('भ्रष्टाचार') || /भ्रष्टाचार|घुस|रिसवत|घुसखोरी/.test(hay)) {
        return { category: 'भ्रष्टाचार', classification: 'घुस रिसवत / सरकारी सम्पत्ति हिनामिना', priority: 'उच्च' };
    }
    if (topName.includes('खरिद') || topName.includes('ठेक्का') || /खरिद|ठेक्का|बोलपत्र|टेन्डर/.test(hay)) {
        return { category: 'सार्वजनिक खरिद/ठेक्का', classification: 'सार्वजनिक खरिद सम्बन्धी अनियमितता', priority: 'उच्च' };
    }
    if (topName.includes('निजामती') || topName.includes('कर्मचारी') || /कर्मचारी|आचरण|अनुशासन/.test(hay)) {
        return { category: 'कर्मचारी आचरण', classification: 'विभागीय सजाय / अनुशासन उल्लंघन', priority: 'मध्यम' };
    }
    if (topName.includes('स्थानीय') || /पूर्वाधार|निर्माण|सडक|भवन/.test(hay)) {
        return { category: 'पूर्वाधार निर्माण', classification: 'विकास निर्माण / पूर्वाधार सम्बन्धी', priority: 'मध्यम' };
    }
    if (topName.includes('सुशासन') || /सुशासन|पारदर्शिता|जवाफदेहिता/.test(hay)) {
        return { category: 'नीति/निर्णय प्रक्रिया', classification: 'जिम्मेवारी र पारदर्शिता उल्लंघन', priority: 'न्यून' };
    }
    return { category: 'अन्य', classification: 'अन्य', priority: 'न्यून' };
}

function buildCommitteeDecisionFromSources(complaint, meta, suggestedLaws) {
    const category = meta.category || 'अन्य';
    const top = (suggestedLaws && suggestedLaws[0]) ? suggestedLaws[0] : null;
    const lawRef = top
        ? ` (${top.name}${top.section ? ', ' + top.section : ''} बमोजिम)`
        : '';

    let committeeDecision = '';
    let investigationProcedure = '';

    if (category === 'भ्रष्टाचार') {
        committeeDecision = 'प्रस्तुत उजुरी बेहोरा अध्ययन गर्दा गम्भीर किसिमको भ्रष्टाचारजन्य कार्य भएको शङ्कास्पद देखिएकोले, आवश्यक थप अनुसन्धान, छानविन र कानूनी कारबाहीको लागि अख्तियार दुरुपयोग अनुसन्धान आयोग (CIAA) मा लेखी पठाउने र राष्ट्रिय सतर्कता केन्द्रका तर्फबाट आवश्यक सहयोग जारी राख्ने निर्णय प्रस्ताव गरिन्छ।';
        investigationProcedure = '१. उजुरीमा उल्लेखित घटनासँग सम्बन्धित बजेट निकासा, भुक्तानी बिल, र कार्यसम्पन्न प्रतिवेदनका प्रमाणित प्रतिलिपिहरू माग गर्ने।\n२. सम्बन्धित जिम्मेवार पदाधिकारी वा कर्मचारीहरूको तीन पुस्ते विवरण र स्पष्टीकरण पत्र प्राप्त गर्ने।\n३. आर्थिक हिनामिना र गैरकानूनी लाभ लिएको प्रमाणहरू संकलन गर्ने।';
    } else if (category === 'सार्वजनिक खरिद/ठेक्का') {
        committeeDecision = 'सार्वजनिक खरिद ऐन, २०६३ र सार्वजनिक खरिद नियमावली, २०६४ को मर्म विपरीत बोलपत्र वा ठेक्का प्रक्रियामा गम्भीर अनियमितता भएको देखिन आएकोले, खरिद सम्बन्धी सम्पूर्ण सक्कल कागजातहरू झिकाई स्पष्टीकरण माग गर्ने र राय प्रतिक्रिया माग गर्न सम्बन्धित मन्त्रालय/निकायलाई पत्राचार गर्ने निर्णय प्रस्ताव गरिन्छ।';
        investigationProcedure = '१. स्वीकृत गुरुयोजना, वार्षिक खरिद योजना र लागत अनुमानको स्वीकृत प्रतिलिपि झिकाउने।\n२. बोलपत्र आह्वान सम्बन्धी सूचना, बोलपत्र मूल्याङ्कन समितिको प्रतिवेदन र निर्णयको प्रतिलिपि माग गर्ने।\n३. प्राविधिक विशेषज्ञ संलग्न गराई कार्यस्थलको स्थलगत अनुगमन र नापजाँच प्रतिवेदन प्राप्त गर्ने।';
    } else if (category === 'कर्मचारी आचरण') {
        committeeDecision = 'कर्मचारीहरूको आचरण र अनुशासन उल्लंघन सम्बन्धी बेहोरा निजामती सेवा ऐन, २०४९ अन्तर्गत सजाय आकर्षित हुने प्रकृतिको देखिएकोले, सम्बद्ध कर्मचारीसँग स्पष्टीकरण माग गर्ने र निजको सेवा विवरण सहित विभागीय सजाय प्रक्रिया अघि बढाउन अख्तियारवाला (सम्बन्धित मन्त्रालय/निकाय) समक्ष लेखी पठाउने निर्णय प्रस्ताव गरिन्छ।';
        investigationProcedure = '१. सम्बन्धित कर्मचारीको हाजिरी र कार्यसम्पादन सम्बन्धी प्रतिवेदनहरू माग गर्ने।\n२. पदीय मर्यादा र आचरण विपरीत कार्य गरेको बेहोरा पुष्टि हुने प्रमाण र साक्षी विवरणहरू संकलन गर्ने।\n३. कार्यालय प्रमुखको राय प्रतिक्रिया र स्पष्टीकरण पत्र झिकाउने।';
    } else {
        committeeDecision = 'उजुरीमा उल्लेखित बेहोराको सम्बन्धमा सम्बन्धित स्थानीय तह वा मन्त्रालयसँग राय प्रतिक्रिया माग गर्ने र सम्बद्ध ऐन-कानूनका प्रावधानहरू अनुसार १५ दिनभित्र आवश्यक छानविन तथा कारबाही गरी राष्ट्रिय सतर्कता केन्द्रलाई जानकारी पठाउन निर्देशनात्मक पत्र लेखी पठाउने निर्णय प्रस्ताव गरिन्छ।';
        investigationProcedure = '१. उजुरीको बेहोरा खुल्ने गरी सम्बन्धित कार्यालयसँग राय प्रतिक्रिया माग गर्ने।\n२. निर्णय प्रक्रियासँग सम्बन्धित कागजातहरू र फायलहरू झिकाउने।\n३. उजुरीकर्तासँग आवश्यक थप विवरण वा प्रमाण भए माग गर्ने।';
    }

    if (lawRef && !committeeDecision.includes(lawRef.trim())) {
        committeeDecision += lawRef;
    }

    return { committeeDecision, investigationProcedure };
}

function mergeAllSuggestedLaws(aiLaws, databaseLaws, limit) {
    limit = limit || 6;
    const out = [];
    const seen = new Set();
    function push(item) {
        if (!item || !item.name) return;
        const key = (String(item.name) + '::' + String(item.section || '')).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
            name: String(item.name).trim(),
            section: item.section || '',
            description: item.description || ''
        });
    }
    (aiLaws || []).concat(databaseLaws || []).forEach(push);
    return out.slice(0, limit);
}

function finalizeAnalysis(complaint, analysisObj) {
    const dbSuggested = buildSuggestedLawsFromDatabase(complaint, 5);
    analysisObj.suggestedLaws = mergeAllSuggestedLaws(
        analysisObj.suggestedLaws || [],
        dbSuggested,
        6
    );

    const inferred = inferCategoryFromComplaint(complaint, analysisObj.suggestedLaws);
    if (!analysisObj.category || analysisObj.category === 'अन्य') analysisObj.category = inferred.category;
    if (!analysisObj.classification || analysisObj.classification === 'अन्य') {
        analysisObj.classification = inferred.classification;
    }
    if (!analysisObj.priority) analysisObj.priority = inferred.priority;

    const weakDecision = !analysisObj.committeeDecision ||
        String(analysisObj.committeeDecision).trim().length < 45;
    const weakProcedure = !analysisObj.investigationProcedure ||
        String(analysisObj.investigationProcedure).trim().length < 25;

    if (weakDecision || weakProcedure) {
        const built = buildCommitteeDecisionFromSources(complaint, {
            category: analysisObj.category,
            classification: analysisObj.classification,
            priority: analysisObj.priority
        }, analysisObj.suggestedLaws);
        if (weakDecision) analysisObj.committeeDecision = built.committeeDecision;
        if (weakProcedure) analysisObj.investigationProcedure = built.investigationProcedure;
    } else {
        const top = analysisObj.suggestedLaws[0];
        if (top && top.name && !String(analysisObj.committeeDecision).includes(top.name)) {
            analysisObj.committeeDecision += ` (सम्बन्धित: ${top.name}${top.section ? ', ' + top.section : ''})`;
        }
    }

    analysisObj.sources = ['laws_database.json'];
    if (!analysisObj.source) analysisObj.source = 'laws_database_only';
    return analysisObj;
}

function buildRelevantLawContext(complaint, limit = 6) {
    const scored = lawsDatabase.map(law => {
        const baseScore = scoreLawRelevance(complaint, law);
        return { law, score: baseScore };
    }).filter(item => item.score > 0);

    const topLaws = scored.sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.law);
    return topLaws.map(law => {
        let body = getLawSearchableText(law);
        if (Array.isArray(law.sections) && law.sections.length) {
            const topSecs = law.sections
                .map((sec) => ({ sec, score: scoreSectionRelevance(complaint, sec, 0) }))
                .filter((x) => x.score >= 2)
                .sort((a, b) => b.score - a.score)
                .slice(0, 4)
                .map((x) => `दफा ${x.sec.section_no || ''}: ${x.sec.title || ''}\n${(x.sec.content || '').slice(0, 2000)}`);
            if (topSecs.length) body = topSecs.join('\n\n');
        }
        return `\n[कानूनको नाम: ${law.lawName || law.name}]\n${String(body).substring(0, 15000)}\n`;
    }).join('\n');
}

function buildLocalOnlyAnalysis(complaint) {
    const dbSuggested = buildSuggestedLawsFromDatabase(complaint, 5);
    const suggestedLaws = mergeAllSuggestedLaws([], dbSuggested, 6);
    const inferred = inferCategoryFromComplaint(complaint, suggestedLaws);
    const built = buildCommitteeDecisionFromSources(complaint, inferred, suggestedLaws);
    return finalizeAnalysis(complaint, {
        category: inferred.category,
        priority: inferred.priority,
        classification: inferred.classification,
        committeeDecision: built.committeeDecision,
        investigationProcedure: built.investigationProcedure,
        suggestedLaws,
        source: 'local_database_only'
    });
}

// सर्भर सुरु हुँदा १ सेकेन्डमै JSON लोड गर्ने फंक्सन
function loadJSONDatabase() {
    console.log("⏳ JSON डेटाबेस लोड हुँदैछ...");
    if (fs.existsSync(JSON_DB_PATH)) {
        const rawData = fs.readFileSync(JSON_DB_PATH, 'utf8');
        lawsDatabase = JSON.parse(rawData);
        console.log(`⚡ सफलतापूर्वक ${lawsDatabase.length} वटा कानूनहरू JSON बाट लोड भए। API तयार छ!`);
    } else {
        console.error("❌ त्रुटि: 'laws_database.json' फाइल फेला परेन। पहिले convert.js चलाउनुहोस्।");
    }
}

// १. कानूनको सूची हेर्ने API
app.get('/api/laws', (req, res) => {
    const lawList = lawsDatabase.map(law => law.lawName);
    res.json({ totalLaws: lawList.length, laws: lawList });
});

// २. उजुरी विश्लेषण गर्ने मुख्य AI Endpoint (संरचित JSON सहित)
app.post('/api/analyze-complaint', async (req, res) => {
    const { complaint } = req.body;

    if (!complaint) {
        return res.status(400).json({ error: "कृपया उजुरीको विवरण (complaint) पठाउनुहोस्।" });
    }

    // laws_database.json म्याचिङ प्रयोग गरी सटीक ऐनहरू र दफाहरू खोज्ने

    let analysisObj;
    let fallbackToLocal = false;

    try {
        console.log(`🔍 नयाँ उजुरी विश्लेषण गर्दै: "${complaint}"`);

        // प्रम्प्टका लागि पृष्ठभूमि सन्दर्भ तयार गर्ने
        const relevantContext = buildRelevantLawContext(complaint, 6);
        const dbSuggestedForPrompt = buildSuggestedLawsFromDatabase(complaint, 4);

        // JSON responseType सहितको मोडेल कन्फिगर गर्ने
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            generationConfig: { responseMimeType: "application/json" }
        });

        const prompt = `
        तपाईं नेपालको एक वरिष्ठ कानुनी सल्लाहकार (AI Legal Expert) तथा राष्ट्रिय सतर्कता केन्द्र (NVC) को मुख्य कानूनी विश्लेषक हुनुहुन्छ। 
        तल एक नागरिकले दर्ता गरेको उजुरी/गुनासो दिइएको छ। पृष्ठभूमिमा दिइएका नेपालका कानूनहरू तथा स्थानीय रूपमा पहिचान गरिएका ऐन र प्रावधानहरू अध्ययन गरी यो उजुरीमा कुन ऐनको कुन दफा वा नियम आकर्षित हुन्छ र निर्णय प्रस्ताव के हुनुपर्छ, स्पष्ट विश्लेषण गरिदिनुहोस्।

        [नागरिकको उजुरी]:
        "${complaint}"

        [नेपालका सम्बन्धित कानूनहरू (सन्दर्भ)]:
        ${relevantContext}

        [laws_database.json बाट पहिचान गरिएका प्रावधानहरू]:
        ${JSON.stringify(dbSuggestedForPrompt, null, 2)}

        निर्देशनहरू:
        १. उजुरीको प्रकृति अनुसार आकर्षित हुने ऐनको नाम र दफा/नियम स्पष्ट रूपमा पहिचान गर्नुहोस्। 
        २. 'सम्बन्धित ऐन/कानूनका प्रावधानहरु' (suggestedLaws) मा कुन ऐनको कुन दफा र शीर्षक आकर्षित हुन्छ र त्यसले के व्यवस्था गर्छ (description) स्पष्ट नेपाली भाषामा लेख्नुहोस्।
        ३. 'उजुरी व्यवस्थापन समितिको निर्णय प्रस्ताव' (committeeDecision) मा उजुरीको कानूनी विश्लेषण गरी अब समितिले के निर्णय गर्ने हो (जस्तै: अख्तियार दुरुपयोग अनुसन्धान आयोगमा पठाउने, विभागीय कारबाहीको लागि लेखी पठाउने, स्पष्टीकरण माग गर्ने, वा सम्बन्धित मन्त्रालय/निकायमा छानविनको लागि पठाउने) स्पष्ट र औपचारिक नेपाली कानुनी भाषामा निर्णय प्रस्ताव तयार पार्नुहोस्।
        ४. 'छानविन प्रकृया सुझाव' (investigationProcedure) मा उजुरीको सत्यतथ्य छानविन गर्न के कस्ता कागजात वा प्रमाण जुटाउनुपर्छ र कुन निकायबाट विवरण माग गर्नुपर्छ, स्पष्ट लेख्नुहोस्।
        ५. उजुरीको वर्गीकरण (classification / category) र प्राथमिकता (priority - "उच्च", "मध्यम", "न्यून") तोक्नुहोस्।

        अनिवार्य रूपमा निम्न कुञ्जीहरू (keys) भएको JSON ढाँचामा मात्र जवाफ दिनुहोस् (कुनै अन्य बाह्य पाठ वा विवरण नलेख्नुहोस्):
        {
          "category": "उजुरीको मुख्य श्रेणी, जस्तै: भ्रष्टाचार / सार्वजनिक खरिद/ठेक्का / पूर्वाधार निर्माण / सेवा प्रवाह / कर्मचारी आचरण / नीति/निर्णय प्रक्रिया / अन्य",
          "priority": "उच्च वा मध्यम वा न्यून",
          "classification": "उजुरीको विशिष्ट वर्गीकरण, जस्तै: गैरकानूनी सम्पत्ति आर्जन / घुस रिसवत / सरकारी सम्पत्तिको हिनामिना / सार्वजनिक खरिद सम्बन्धी / आदि",
          "committeeDecision": "उजुरी व्यवस्थापन समितिको निर्णय प्रस्ताव (सटीक र औपचारिक नेपाली कानूनी व्यहोरा)",
          "investigationProcedure": "छानविन प्रकृया सुझाव (गर्नुपर्ने कार्यहरू र विवरण माग गर्ने निकाय)",
          "suggestedLaws": [
            {
              "name": "ऐन/नियमको सही नाम (जस्तै: भ्रष्टाचार निवारण ऐन, २०५९)",
              "section": "सम्बन्धित दफा वा नियम र शीर्षक (जस्तै: दफा १७ - गलत लिखत तयार गर्ने)",
              "description": "यो दफा वा नियममा भएको व्यवस्था र यो उजुरीसँग यसको सम्बन्धको संक्षिप्त विश्लेषण"
            }
          ]
        }
        `;

        const aiResult = await model.generateContent(prompt);
        const responseText = aiResult.response.text();

        try {
            analysisObj = JSON.parse(responseText);
            if (!Array.isArray(analysisObj.suggestedLaws)) {
                analysisObj.suggestedLaws = [];
            }
        } catch (parseError) {
            console.error("❌ AI प्रतिक्रिया पार्स गर्न त्रुटि आयो, स्थानीय फलब्याक लागू हुँदैछ:", parseError);
            fallbackToLocal = true;
        }

    } catch (error) {
        console.warn("⚠️ Gemini API कल असफल भयो। स्थानीय क्याटलग आधारित सटीक विश्लेषण लागू हुँदैछ:", error.message);
        fallbackToLocal = true;
    }

    // यदि Gemini उपलब्ध नभए वा पार्स गर्न असफल भएमा, laws_database को आधारमा सटीक फलब्याक तयार पार्ने
    if (fallbackToLocal) {
        analysisObj = buildLocalOnlyAnalysis(complaint);
    }

    analysisObj = finalizeAnalysis(complaint, analysisObj || {});

    res.json({
        status: "success",
        analysis: analysisObj
    });
});


// ३. Gemini बिना laws_database मात्र (फलब्याक)
app.post('/api/analyze-complaint-local', (req, res) => {
    const { complaint } = req.body;
    if (!complaint) {
        return res.status(400).json({ error: 'कृपया उजुरीको विवरण (complaint) पठाउनुहोस्।' });
    }
    const analysis = buildLocalOnlyAnalysis(complaint);
    res.json({ status: 'success', analysis });
});

app.listen(PORT, () => {
    loadJSONDatabase();
    console.log(`🚀 सर्भर यहाँ चल्दैछ: http://localhost:${PORT}`);
});
