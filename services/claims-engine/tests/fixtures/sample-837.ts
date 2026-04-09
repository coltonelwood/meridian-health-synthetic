/**
 * Sample X12 837P (Professional) test data.
 *
 * These are synthetic EDI transactions for testing. They are based on
 * real-world examples but all patient/provider data is fictitious.
 *
 * Format: ANSI X12 005010X222A1 (837 Professional)
 */

// A simple office visit claim - single line, single diagnosis
export const SIMPLE_OFFICE_VISIT_837 = [
  'ISA*00*          *00*          *ZZ*MERIDIAN       *ZZ*00590          *240115*1230*^*00501*000000001*0*T*:~',
  'GS*HC*MERIDIAN*00590*20240115*1230*1*X*005010X222A1~',
  'ST*837*0001*005010X222A1~',
  'BHT*0019*00*CLM-20240115-A1B2C*20240115*1230*CH~',
  'NM1*41*2*MERIDIAN HEALTH TECHNOLOGIES*****46*MERIDIANHT~',
  'PER*IC*CLAIMS DEPT*TE*8005551234*EM*claims@meridianhealth.example.com~',
  'NM1*40*2*BLUECROSS BLUESHIELD OF FLORIDA*****46*00590~',
  'HL*1**20*1~',
  'PRV*BI*PXC*207Q00000X~',
  'NM1*85*2*SUNSHINE FAMILY MEDICINE*****XX*1234567890~',
  'N3*456 OAK AVE*SUITE 200~',
  'N4*TAMPA*FL*336012345~',
  'REF*EI*123456789~',
  'HL*2*1*22*0~',
  'SBR*P*18*GRP001*BCBS FL PPO*****CI~',
  'NM1*IL*1*SMITH*JOHN*****MI*SUB123456~',
  'N3*789 PINE ST~',
  'N4*TAMPA*FL*33601~',
  'DMG*D8*19800515*M~',
  'NM1*PR*2*BLUECROSS BLUESHIELD OF FLORIDA*****PI*00590~',
  'CLM*CLM-20240115-A1B2C*150.00***11:B:1*Y*A*Y*I~',
  'DTP*472*D8*20240115~',
  'HI*ABK:J0600~',
  'SV1*HC:99213*150.00*UN*1*11**1~',
  'DTP*472*D8*20240115~',
  'SE*24*0001~',
  'GE*1*1~',
  'IEA*1*000000001~',
].join('\n');

// Multi-line claim - E&M + procedure with modifier 25
export const MULTI_LINE_CLAIM_837 = [
  'ISA*00*          *00*          *ZZ*MERIDIAN       *ZZ*60054          *240220*0930*^*00501*000000002*0*T*:~',
  'GS*HC*MERIDIAN*60054*20240220*0930*2*X*005010X222A1~',
  'ST*837*0002*005010X222A1~',
  'BHT*0019*00*CLM-20240220-D3E4F*20240220*0930*CH~',
  'NM1*41*2*MERIDIAN HEALTH TECHNOLOGIES*****46*MERIDIANHT~',
  'PER*IC*CLAIMS DEPT*TE*8005551234~',
  'NM1*40*2*AETNA*****46*60054~',
  'HL*1**20*1~',
  'PRV*BI*PXC*207Q00000X~',
  'NM1*85*2*COASTAL ORTHOPEDICS*****XX*9876543210~',
  'N3*100 BEACH BLVD~',
  'N4*CLEARWATER*FL*337561234~',
  'REF*EI*987654321~',
  'HL*2*1*22*0~',
  'SBR*P*18*GRP002*AETNA PPO*****CI~',
  'NM1*IL*1*JOHNSON*MARIA*E****MI*AET987654~',
  'N3*555 ELM DRIVE~',
  'N4*CLEARWATER*FL*33756~',
  'DMG*D8*19750823*F~',
  'NM1*PR*2*AETNA*****PI*60054~',
  'NM1*DN*1*WILLIAMS*ROBERT*****XX*5555555555~',
  'CLM*CLM-20240220-D3E4F*475.00***11:B:1*Y*A*Y*I~',
  'DTP*472*D8*20240220~',
  'HI*ABK:M5456*ABK:M5416~',
  'SV1*HC:99214:25*225.00*UN*1*11**1~',
  'DTP*472*D8*20240220~',
  'SV1*HC:20610*250.00*UN*1*11**1:2~',
  'DTP*472*D8*20240220~',
  'SE*28*0002~',
  'GE*1*2~',
  'IEA*1*000000002~',
].join('\n');

// Sample 835 (Remittance Advice) for the simple office visit claim
export const SIMPLE_REMITTANCE_835 = [
  'ISA*00*          *00*          *ZZ*00590          *ZZ*MERIDIAN       *240201*1400*^*00501*000000100*0*T*:~',
  'GS*HP*00590*MERIDIAN*20240201*1400*100*X*005010X221A1~',
  'ST*835*0100~',
  'BPR*I*105.00*C*ACH*CCP*01*999999999*DA*123456789**01*999888777*DA*987654321*20240201~',
  'TRN*1*TRACE123456*1234567890~',
  'DTM*405*20240201~',
  'N1*PR*BLUECROSS BLUESHIELD OF FLORIDA*PI*00590~',
  'N1*PE*SUNSHINE FAMILY MEDICINE*XX*1234567890~',
  'CLP*CLM-20240115-A1B2C*1*150.00*105.00*15.00**CI*CLM00001~',
  'CAS*CO*45*30.00~',
  'CAS*PR*3*15.00~',
  'NM1*QC*1*SMITH*JOHN****MI*SUB123456~',
  'SVC*HC:99213*150.00*105.00**1~',
  'CAS*CO*45*30.00~',
  'CAS*PR*3*15.00~',
  'DTM*472*20240115~',
  'LQ*HE*N362~',
  'SE*16*0100~',
  'GE*1*100~',
  'IEA*1*000000100~',
].join('\n');

// Denied claim remittance
export const DENIED_REMITTANCE_835 = [
  'ISA*00*          *00*          *ZZ*60054          *ZZ*MERIDIAN       *240305*0800*^*00501*000000200*0*T*:~',
  'GS*HP*60054*MERIDIAN*20240305*0800*200*X*005010X221A1~',
  'ST*835*0200~',
  'BPR*I*0.00*C*NON************20240305~',
  'TRN*1*TRACE789012*9876543210~',
  'N1*PR*AETNA*PI*60054~',
  'N1*PE*COASTAL ORTHOPEDICS*XX*9876543210~',
  'CLP*CLM-20240220-D3E4F*4*475.00*0.00*0.00**CI~',
  'CAS*CO*197*475.00~',
  'NM1*QC*1*JOHNSON*MARIA*E***MI*AET987654~',
  'SVC*HC:99214:25*225.00*0.00**1~',
  'CAS*CO*197*225.00~',
  'DTM*472*20240220~',
  'SVC*HC:20610*250.00*0.00**1~',
  'CAS*CO*197*250.00~',
  'DTM*472*20240220~',
  'SE*15*0200~',
  'GE*1*200~',
  'IEA*1*000000200~',
].join('\n');

// Partial payment remittance (some lines paid, some denied)
export const PARTIAL_PAYMENT_835 = [
  'ISA*00*          *00*          *ZZ*87726          *ZZ*MERIDIAN       *240410*1100*^*00501*000000300*0*T*:~',
  'GS*HP*87726*MERIDIAN*20240410*1100*300*X*005010X221A1~',
  'ST*835*0300~',
  'BPR*I*180.00*C*ACH*CCP*01*888888888*DA*111222333**01*444555666*DA*777888999*20240410~',
  'TRN*1*TRACE345678*8888888888~',
  'N1*PR*UNITEDHEALTHCARE*PI*87726~',
  'N1*PE*MERIDIAN HEALTH SERVICES*XX*1111111111~',
  'CLP*CLM-20240401-X9Y8Z*1*650.00*180.00*120.00**CI*UHC_CLM_5555~',
  'CAS*CO*45*200.00~',
  'CAS*PR*1*100.00*PR*2*50.00*PR*3*30.00~',
  'CAS*CO*96*90.00~',
  'NM1*QC*1*GARCIA*ROBERTO****MI*UHC000123~',
  'SVC*HC:99214*225.00*150.00**1~',
  'CAS*CO*45*45.00~',
  'CAS*PR*3*30.00~',
  'DTM*472*20240401~',
  'LQ*HE*N362~',
  'SVC*HC:90834*175.00*30.00**1~',
  'CAS*CO*45*55.00~',
  'CAS*PR*1*50.00*PR*2*40.00~',
  'DTM*472*20240401~',
  'SVC*HC*85025*100.00*0.00**1~',
  'CAS*CO*96*100.00~',
  'DTM*472*20240401~',
  'LQ*HE*MA130~',
  'SVC*HC:71046*150.00*0.00**1~',
  'CAS*CO*96*150.00~',
  'DTM*472*20240401~',
  'SE*26*0300~',
  'GE*1*300~',
  'IEA*1*000000300~',
].join('\n');

// Helper to create a claim fixture for testing
export function createTestClaim(overrides: Partial<any> = {}) {
  return {
    id: 'test-claim-001',
    claimNumber: 'CLM-20240115-A1B2C',
    status: 'DRAFT',
    claimType: 'PROFESSIONAL',
    filingIndicator: 'COMMERCIAL',
    subscriberId: 'SUB123456',
    patient: {
      patientId: 'PAT001',
      firstName: 'John',
      lastName: 'Smith',
      dateOfBirth: '1980-05-15',
      gender: 'M',
      addressLine1: '789 Pine St',
      city: 'Tampa',
      state: 'FL',
      zip: '33601',
      relationshipToSubscriber: '18',
    },
    provider: {
      billingProviderNpi: '1234567890',
      billingProviderTaxId: '123456789',
      billingProviderName: 'Sunshine Family Medicine',
      renderingProviderNpi: '1234567890',
      placeOfService: '11',
    },
    payer: {
      payerId: '00590',
      payerName: 'BlueCross BlueShield of Florida',
      groupNumber: 'GRP001',
    },
    diagnosisCodes: ['J06.9'],
    diagnosisCodeType: 'ABK',
    totalChargeAmount: 150.00,
    serviceDateFrom: '2024-01-15',
    createdAt: new Date('2024-01-15T12:00:00Z'),
    updatedAt: new Date('2024-01-15T12:00:00Z'),
    version: 1,
    metadata: {},
    ...overrides,
  };
}

export function createTestClaimLines(claimId: string = 'test-claim-001', overrides: Partial<any>[] = []) {
  const defaultLine = {
    id: 'test-line-001',
    claimId,
    lineNumber: 1,
    cptCode: '99213',
    diagnosisPointer: [1],
    placeOfService: '11',
    serviceDateFrom: '2024-01-15',
    units: 1,
    chargeAmount: 150.00,
    createdAt: new Date('2024-01-15T12:00:00Z'),
    updatedAt: new Date('2024-01-15T12:00:00Z'),
  };

  if (overrides.length === 0) {
    return [defaultLine];
  }

  return overrides.map((override, idx) => ({
    ...defaultLine,
    id: `test-line-${String(idx + 1).padStart(3, '0')}`,
    lineNumber: idx + 1,
    ...override,
  }));
}
