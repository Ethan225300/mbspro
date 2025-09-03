const fetch = require('node-fetch');

async function testSmartMode() {
  const API_BASE = 'http://localhost:4000';
  
  console.log('🧠 Testing Smart Mode...');
  
  try {
    const response = await fetch(`${API_BASE}/api/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note: '35岁患者胸痛持续30分钟',
        mode: 'smart',
        topN: 3
      })
    });
    
    if (!response.ok) {
      console.error('❌ API Error:', response.status, response.statusText);
      const text = await response.text();
      console.error('Response:', text);
      return;
    }
    
    const data = await response.json();
    console.log('✅ Smart Mode Response:');
    console.log('Candidates:', data.candidates?.length || 0);
    
    if (data.candidates && data.candidates.length > 0) {
      console.log('\n📋 Sample Result:');
      const sample = data.candidates[0];
      console.log('- Code:', sample.code);
      console.log('- Title:', sample.title);
      console.log('- Match Reason:', sample.match_reason || sample.short_explain);
      console.log('- Confidence:', sample.confidence);
    }
    
  } catch (error) {
    console.error('❌ Test Error:', error.message);
  }
}

// Also test RAG Smart endpoint directly
async function testRagSmart() {
  const API_BASE = 'http://localhost:4000';
  
  console.log('\n🧠 Testing RAG Smart Endpoint...');
  
  try {
    const response = await fetch(`${API_BASE}/api/rag/smart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note: '35岁患者胸痛持续30分钟',
        top: 3
      })
    });
    
    if (!response.ok) {
      console.error('❌ RAG Smart API Error:', response.status);
      const text = await response.text();
      console.error('Response:', text);
      return;
    }
    
    const data = await response.json();
    console.log('✅ RAG Smart Response:');
    console.log('Results:', data.results?.length || 0);
    
    if (data.results && data.results.length > 0) {
      console.log('\n📋 Sample RAG Result:');
      const sample = data.results[0];
      console.log('- Item:', sample.itemNum);
      console.log('- Title:', sample.title);
      console.log('- Match Reason:', sample.match_reason);
    }
    
  } catch (error) {
    console.error('❌ RAG Smart Test Error:', error.message);
  }
}

testSmartMode().then(() => testRagSmart()).then(() => {
  console.log('\n🏁 Smart Mode Testing Complete');
});