// Use Node.js built-in fetch (Node 18+)
async function testConnection() {
  const API_BASE = 'http://localhost:4000';
  
  console.log('🔗 Testing API connection...');
  
  try {
    // Test basic status
    console.log('1. Testing API status...');
    const statusResponse = await fetch(`${API_BASE}/api/rag/status`);
    
    if (!statusResponse.ok) {
      console.error(`❌ API Status failed: ${statusResponse.status} ${statusResponse.statusText}`);
      return;
    }
    
    const statusData = await statusResponse.json();
    console.log('✅ API Status OK:', statusData);
    
    // Test suggest endpoint
    console.log('\n2. Testing suggest endpoint...');
    const suggestResponse = await fetch(`${API_BASE}/api/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note: 'Test patient',
        mode: 'quick',
        topN: 1
      })
    });
    
    if (!suggestResponse.ok) {
      console.error(`❌ Suggest API failed: ${suggestResponse.status} ${suggestResponse.statusText}`);
      const text = await suggestResponse.text();
      console.error('Response:', text);
      return;
    }
    
    const suggestData = await suggestResponse.json();
    console.log('✅ Suggest API OK:', {
      candidatesCount: suggestData.candidates?.length || 0,
      hasSignals: !!suggestData.signals
    });
    
    // Test smart mode specifically  
    console.log('\n3. Testing Smart mode...');
    const smartResponse = await fetch(`${API_BASE}/api/suggest`, {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note: 'Patient with chest pain',
        mode: 'smart',
        topN: 2
      })
    });
    
    if (!smartResponse.ok) {
      console.error(`❌ Smart mode failed: ${smartResponse.status} ${smartResponse.statusText}`);
      const text = await smartResponse.text();
      console.error('Response:', text);
      return;
    }
    
    const smartData = await smartResponse.json();
    console.log('✅ Smart mode OK:', {
      candidatesCount: smartData.candidates?.length || 0,
      sampleCandidate: smartData.candidates?.[0] ? {
        code: smartData.candidates[0].code,
        title: smartData.candidates[0].title,
        match_reason: smartData.candidates[0].match_reason || smartData.candidates[0].short_explain
      } : null
    });
    
    console.log('\n🎉 All tests passed! API is working correctly.');
    
  } catch (error) {
    console.error('❌ Connection test failed:', error.message);
    console.error('Make sure the API server is running on port 4000');
    console.error('Try: cd apps/api && npm run dev');
  }
}

testConnection();