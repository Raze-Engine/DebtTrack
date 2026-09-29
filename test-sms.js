require('dotenv').config();

async function testSMS() {
    console.log("Sending request to Cloud Function endpoint...");

    try {
        const response = await fetch(process.env.SMS_GATEWAY_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-API-Key': process.env.SMS_GATEWAY_KEY
            },
            body: JSON.stringify({
                phoneNumber: process.env.ADMIN_PHONE,
                message: "Test SMS from DebtTrack"
            })
        });

        const status = response.status;
        const text = await response.text();
        console.log("HTTP Status:", status);
        console.log("Response Body:", text);
    } catch (err) {
        console.error("Fetch Error:", err.message);
    }
}

testSMS();