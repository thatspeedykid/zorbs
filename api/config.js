export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ablyKey: process.env.ABLY_API_KEY || 'CtKemg.EbPCaQ:UkXWMenOtctecuS8DixPP3O6UimGDwW2UBlxk4gRoi0',
  });
}
