"""
Meridian Health Technologies - Billing Calculator v1 (DEPRECATED)

DEPRECATED: This module has been replaced by services/billing.
Kept for reference only. Do not import or use in new code.

Original author: Priya Sharma
Created: 2020-03
Last modified: 2024-02 (bug fix for negative adjustments)
"""

import decimal
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, date
import json
import logging

# Force decimal precision for financial calculations
decimal.getcontext().prec = 10

logger = logging.getLogger(__name__)

# Hardcoded payer contract IDs - yes, this is terrible
PAYER_MEDICARE = 'MCRE'
PAYER_MEDICAID = 'MCAD'
PAYER_BCBS = 'BCBS'
PAYER_AETNA = 'AETN'
PAYER_CIGNA = 'CGNA'
PAYER_UNITED = 'UHHC'
PAYER_HUMANA = 'HMNA'
PAYER_SELF_PAY = 'SELF'


def calculate_patient_responsibility(
    cpt_code,
    diagnosis_codes,
    payer_id,
    contract_rates,
    patient_benefits,
    service_date,
    rendering_provider_npi,
    facility_code=None,
    modifiers=None
):
    """
    Calculate patient responsibility for a given service.

    This function is a monster. It handles way too many things.
    The new billing service breaks this into separate calculators
    for each step of the adjudication process.

    Args:
        cpt_code: CPT procedure code (e.g., '99213')
        diagnosis_codes: List of ICD-10 codes
        payer_id: Payer identifier
        contract_rates: Dict of payer contract rates
        patient_benefits: Dict with deductible, oop_max, etc.
        service_date: Date of service
        rendering_provider_npi: Provider's NPI number
        facility_code: Place of service code (optional)
        modifiers: List of CPT modifiers (optional)

    Returns:
        dict with breakdown of charges, allowed, adjustments, patient responsibility
    """
    modifiers = modifiers or []
    facility_code = facility_code or '11'  # Default to office

    result = {
        'cpt_code': cpt_code,
        'service_date': service_date.isoformat() if isinstance(service_date, (date, datetime)) else service_date,
        'billed_amount': Decimal('0.00'),
        'allowed_amount': Decimal('0.00'),
        'contractual_adjustment': Decimal('0.00'),
        'deductible_applied': Decimal('0.00'),
        'copay': Decimal('0.00'),
        'coinsurance': Decimal('0.00'),
        'patient_responsibility': Decimal('0.00'),
        'payer_responsibility': Decimal('0.00'),
        'notes': []
    }

    # Step 1: Look up the billed (charge) amount from our fee schedule
    billed_amount = get_charge_amount(cpt_code, facility_code)
    if billed_amount is None:
        logger.error(f"No charge amount found for CPT {cpt_code}")
        result['notes'].append(f"ERROR: No charge amount for CPT {cpt_code}")
        return result

    result['billed_amount'] = Decimal(str(billed_amount))

    # Step 2: Look up the allowed amount from the payer contract
    if payer_id == PAYER_SELF_PAY:
        # Self-pay patients get a discount
        # TODO: This discount percentage should be configurable, not hardcoded
        self_pay_discount = Decimal('0.40')  # 40% discount
        allowed = result['billed_amount'] * (1 - self_pay_discount)
        result['allowed_amount'] = allowed.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        result['contractual_adjustment'] = result['billed_amount'] - result['allowed_amount']
        result['patient_responsibility'] = result['allowed_amount']
        result['notes'].append('Self-pay discount applied (40%)')
        return result

    allowed_amount = get_contract_rate(payer_id, cpt_code, contract_rates, service_date)
    if allowed_amount is None:
        # If no contract rate, use Medicare as fallback
        # This is a business rule that caused many arguments
        allowed_amount = get_medicare_rate(cpt_code, service_date)
        result['notes'].append('No contract rate found; Medicare rate used as fallback')
        logger.warning(f"No contract rate for payer {payer_id}, CPT {cpt_code}. Using Medicare rate.")

    if allowed_amount is None:
        # Last resort - use billed amount (shouldn't happen)
        allowed_amount = billed_amount
        result['notes'].append('WARNING: No rate found; using billed amount')

    result['allowed_amount'] = Decimal(str(allowed_amount)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

    # Apply modifiers
    result['allowed_amount'] = apply_modifiers(result['allowed_amount'], modifiers)

    # Step 3: Calculate contractual adjustment
    result['contractual_adjustment'] = max(
        result['billed_amount'] - result['allowed_amount'],
        Decimal('0.00')
    )

    # Step 4: Calculate patient responsibility
    remaining = result['allowed_amount']

    # 4a: Apply copay (if applicable for this service type)
    copay = get_copay_amount(patient_benefits, cpt_code, facility_code)
    if copay > Decimal('0.00'):
        result['copay'] = min(copay, remaining)
        remaining -= result['copay']

    # 4b: Apply deductible
    deductible_remaining = get_deductible_remaining(patient_benefits)
    if deductible_remaining > Decimal('0.00'):
        deductible_applied = min(deductible_remaining, remaining)
        result['deductible_applied'] = deductible_applied
        remaining -= deductible_applied

    # 4c: Calculate coinsurance on the remaining amount
    coinsurance_pct = get_coinsurance_percentage(patient_benefits, payer_id)
    if coinsurance_pct > Decimal('0.00') and remaining > Decimal('0.00'):
        coinsurance = (remaining * coinsurance_pct).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        result['coinsurance'] = coinsurance
        remaining -= coinsurance

    # Step 5: Check out-of-pocket maximum
    oop_remaining = get_oop_remaining(patient_benefits)
    total_patient = result['copay'] + result['deductible_applied'] + result['coinsurance']

    if total_patient > oop_remaining:
        # Patient has hit their OOP max
        excess = total_patient - oop_remaining
        result['coinsurance'] = max(result['coinsurance'] - excess, Decimal('0.00'))
        total_patient = oop_remaining
        result['notes'].append('Patient OOP maximum reached; excess shifted to payer')

    result['patient_responsibility'] = (
        result['copay'] + result['deductible_applied'] + result['coinsurance']
    ).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

    result['payer_responsibility'] = (
        result['allowed_amount'] - result['patient_responsibility']
    ).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

    # Sanity check
    if result['payer_responsibility'] < Decimal('0.00'):
        logger.error(
            f"Negative payer responsibility calculated: {result['payer_responsibility']} "
            f"for CPT {cpt_code}, payer {payer_id}"
        )
        result['notes'].append('ERROR: Negative payer responsibility - needs manual review')
        # BUG: We used to just set this to zero and move on, which caused
        # discrepancies in our AR reports. The new system raises an exception instead.
        result['payer_responsibility'] = Decimal('0.00')

    return result


def get_charge_amount(cpt_code, facility_code):
    """
    Look up the charge amount from our internal fee schedule.

    In production, this queried the fee_schedule table.
    These are placeholder values for reference.
    """
    # Abbreviated fee schedule - in production this was a database lookup
    fee_schedule = {
        '99201': Decimal('95.00'),
        '99202': Decimal('165.00'),
        '99203': Decimal('225.00'),
        '99204': Decimal('325.00'),
        '99205': Decimal('425.00'),
        '99211': Decimal('45.00'),
        '99212': Decimal('95.00'),
        '99213': Decimal('150.00'),
        '99214': Decimal('225.00'),
        '99215': Decimal('325.00'),
        '99381': Decimal('275.00'),  # Preventive new patient
        '99391': Decimal('225.00'),  # Preventive established
        '99395': Decimal('250.00'),  # Preventive 18-39
        '99396': Decimal('275.00'),  # Preventive 40-64
        '36415': Decimal('12.00'),   # Venipuncture
        '85025': Decimal('35.00'),   # CBC
        '80053': Decimal('65.00'),   # Comprehensive metabolic panel
        '80061': Decimal('85.00'),   # Lipid panel
        '81001': Decimal('18.00'),   # Urinalysis
        '71046': Decimal('175.00'),  # Chest X-ray
        '93000': Decimal('125.00'),  # EKG
        '90471': Decimal('35.00'),   # Immunization admin
        '90658': Decimal('25.00'),   # Flu vaccine
        '90686': Decimal('55.00'),   # Flu vaccine (quadrivalent)
    }

    # Facility vs professional rates differ
    # This is a simplified version - actual logic was more complex
    charge = fee_schedule.get(cpt_code)
    if charge and facility_code != '11':  # Non-office facility
        charge = (charge * Decimal('1.25')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

    return charge


def get_contract_rate(payer_id, cpt_code, contract_rates, service_date):
    """
    Look up the allowed amount from the payer contract.

    Contract rates are effective-dated, so we need to find the rate
    that was in effect on the date of service. This caused SO many bugs.
    """
    if not contract_rates:
        return None

    payer_rates = contract_rates.get(payer_id, {})
    if not payer_rates:
        return None

    code_rates = payer_rates.get(cpt_code, [])
    if not code_rates:
        # Try the code family (e.g., 9921x for all E&M codes)
        code_family = cpt_code[:4] + 'x'
        code_rates = payer_rates.get(code_family, [])

    if not code_rates:
        return None

    # Find the rate effective on the service date
    # Rates are sorted by effective_date descending
    if isinstance(service_date, str):
        service_date = datetime.strptime(service_date, '%Y-%m-%d').date()

    for rate_entry in sorted(code_rates, key=lambda x: x.get('effective_date', ''), reverse=True):
        effective_date = rate_entry.get('effective_date')
        if isinstance(effective_date, str):
            effective_date = datetime.strptime(effective_date, '%Y-%m-%d').date()

        termination_date = rate_entry.get('termination_date')
        if termination_date and isinstance(termination_date, str):
            termination_date = datetime.strptime(termination_date, '%Y-%m-%d').date()

        if effective_date <= service_date:
            if termination_date is None or service_date <= termination_date:
                rate_type = rate_entry.get('rate_type', 'fixed')
                if rate_type == 'fixed':
                    return Decimal(str(rate_entry['amount']))
                elif rate_type == 'percentage_of_medicare':
                    medicare_rate = get_medicare_rate(cpt_code, service_date)
                    if medicare_rate:
                        pct = Decimal(str(rate_entry['percentage']))
                        return (medicare_rate * pct / 100).quantize(Decimal('0.01'))
                elif rate_type == 'percentage_of_charges':
                    charge = get_charge_amount(cpt_code, '11')
                    if charge:
                        pct = Decimal(str(rate_entry['percentage']))
                        return (charge * pct / 100).quantize(Decimal('0.01'))

    return None


def get_medicare_rate(cpt_code, service_date):
    """
    Get the Medicare fee schedule rate.

    In production, this was loaded from CMS fee schedule data files
    that were updated quarterly. Here we use approximate values.
    """
    # Approximate 2024 Medicare rates for common codes
    medicare_rates = {
        '99201': Decimal('46.19'),
        '99202': Decimal('75.06'),
        '99203': Decimal('110.35'),
        '99204': Decimal('167.53'),
        '99205': Decimal('211.10'),
        '99211': Decimal('23.46'),
        '99212': Decimal('57.54'),
        '99213': Decimal('97.52'),
        '99214': Decimal('143.81'),
        '99215': Decimal('193.34'),
        '36415': Decimal('3.01'),
        '85025': Decimal('10.59'),
        '80053': Decimal('14.49'),
        '80061': Decimal('18.38'),
        '81001': Decimal('4.02'),
        '71046': Decimal('30.62'),
        '93000': Decimal('28.48'),
    }
    return medicare_rates.get(cpt_code)


def apply_modifiers(allowed_amount, modifiers):
    """
    Apply CPT modifiers to the allowed amount.

    Modifier logic is notoriously complex. Different payers handle
    modifiers differently. This was a constant source of denials.
    """
    if not modifiers:
        return allowed_amount

    amount = allowed_amount

    for modifier in modifiers:
        if modifier == '25':
            # Significant, separately identifiable E&M service
            # No reduction - full rate
            pass
        elif modifier == '26':
            # Professional component only (no technical)
            amount = (amount * Decimal('0.40')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        elif modifier == 'TC':
            # Technical component only
            amount = (amount * Decimal('0.60')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        elif modifier == '50':
            # Bilateral procedure - 150% of allowed
            amount = (amount * Decimal('1.50')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        elif modifier == '59':
            # Distinct procedural service
            pass
        elif modifier == '76':
            # Repeat procedure by same physician
            amount = (amount * Decimal('0.70')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        elif modifier == '77':
            # Repeat procedure by different physician
            amount = (amount * Decimal('0.70')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        elif modifier == '91':
            # Repeat clinical diagnostic lab test
            amount = (amount * Decimal('1.00')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        else:
            logger.warning(f"Unhandled modifier: {modifier}")

    return amount


def get_copay_amount(patient_benefits, cpt_code, facility_code):
    """
    Determine the copay amount based on service type and benefit plan.
    """
    if not patient_benefits:
        return Decimal('0.00')

    copays = patient_benefits.get('copays', {})

    # Determine service category from CPT code
    # This mapping was incomplete and caused many incorrect copay calculations
    if cpt_code.startswith('992'):
        if facility_code == '11':
            return Decimal(str(copays.get('office_visit', '0.00')))
        elif facility_code == '23':
            return Decimal(str(copays.get('emergency', '0.00')))
        elif facility_code == '22':
            return Decimal(str(copays.get('outpatient_surgery', '0.00')))
        else:
            return Decimal(str(copays.get('specialist', '0.00')))
    elif cpt_code.startswith('993'):
        # Preventive care - usually no copay under ACA
        return Decimal('0.00')
    elif cpt_code.startswith(('7', '8')):
        # Lab/radiology
        return Decimal(str(copays.get('lab', '0.00')))
    elif cpt_code.startswith('9'):
        return Decimal(str(copays.get('specialist', '0.00')))
    else:
        return Decimal(str(copays.get('office_visit', '0.00')))


def get_deductible_remaining(patient_benefits):
    """
    Get the remaining deductible for the current benefit year.
    """
    if not patient_benefits:
        return Decimal('0.00')

    annual_deductible = Decimal(str(patient_benefits.get('annual_deductible', '0.00')))
    deductible_met = Decimal(str(patient_benefits.get('deductible_met_ytd', '0.00')))

    remaining = max(annual_deductible - deductible_met, Decimal('0.00'))
    return remaining


def get_coinsurance_percentage(patient_benefits, payer_id):
    """
    Get the patient's coinsurance percentage.
    Common values: 20% (80/20 plan), 30% (70/30), 10% (90/10)
    """
    if not patient_benefits:
        return Decimal('0.20')  # Default to 80/20

    # In-network vs out-of-network
    is_in_network = patient_benefits.get('in_network', True)

    if is_in_network:
        pct = patient_benefits.get('coinsurance_in_network', 20)
    else:
        pct = patient_benefits.get('coinsurance_out_of_network', 40)

    return Decimal(str(pct)) / Decimal('100')


def get_oop_remaining(patient_benefits):
    """
    Get the remaining out-of-pocket maximum.
    Once the patient hits their OOP max, payer covers 100%.
    """
    if not patient_benefits:
        return Decimal('999999.99')  # Effectively no max

    oop_max = Decimal(str(patient_benefits.get('oop_max', '999999.99')))
    oop_met = Decimal(str(patient_benefits.get('oop_met_ytd', '0.00')))

    return max(oop_max - oop_met, Decimal('0.00'))


def process_claim_batch(claims, contract_rates_lookup):
    """
    Process a batch of claims. Used by the nightly batch job.

    This function was the bottleneck for claim processing.
    It processed claims sequentially. The new service uses
    parallel processing with a work queue.

    Args:
        claims: List of claim dicts
        contract_rates_lookup: Pre-loaded contract rates

    Returns:
        List of processed claim results
    """
    results = []
    errors = []

    for i, claim in enumerate(claims):
        try:
            logger.info(f"Processing claim {i + 1}/{len(claims)}: {claim.get('claim_id')}")

            claim_result = {
                'claim_id': claim['claim_id'],
                'patient_id': claim['patient_id'],
                'line_items': [],
                'total_billed': Decimal('0.00'),
                'total_allowed': Decimal('0.00'),
                'total_patient_responsibility': Decimal('0.00'),
                'total_payer_responsibility': Decimal('0.00'),
                'processed_at': datetime.utcnow().isoformat()
            }

            patient_benefits = claim.get('patient_benefits', {})

            for line_item in claim.get('line_items', []):
                line_result = calculate_patient_responsibility(
                    cpt_code=line_item['cpt_code'],
                    diagnosis_codes=line_item.get('diagnosis_codes', []),
                    payer_id=claim['payer_id'],
                    contract_rates=contract_rates_lookup,
                    patient_benefits=patient_benefits,
                    service_date=line_item.get('service_date', claim.get('service_date')),
                    rendering_provider_npi=claim.get('rendering_provider_npi'),
                    facility_code=line_item.get('facility_code'),
                    modifiers=line_item.get('modifiers', [])
                )

                claim_result['line_items'].append(line_result)
                claim_result['total_billed'] += line_result['billed_amount']
                claim_result['total_allowed'] += line_result['allowed_amount']
                claim_result['total_patient_responsibility'] += line_result['patient_responsibility']
                claim_result['total_payer_responsibility'] += line_result['payer_responsibility']

                # Update running deductible for subsequent line items
                # BUG: This mutated the patient_benefits dict, which caused
                # issues when processing multiple claims for the same patient
                # in the same batch. Fixed in v1.3.2 but never fully resolved.
                deductible_met = Decimal(str(patient_benefits.get('deductible_met_ytd', '0.00')))
                patient_benefits['deductible_met_ytd'] = str(
                    deductible_met + line_result['deductible_applied']
                )

            # Round totals
            for key in ['total_billed', 'total_allowed', 'total_patient_responsibility', 'total_payer_responsibility']:
                claim_result[key] = claim_result[key].quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

            results.append(claim_result)

        except Exception as e:
            logger.error(f"Error processing claim {claim.get('claim_id')}: {str(e)}")
            errors.append({
                'claim_id': claim.get('claim_id'),
                'error': str(e)
            })

    logger.info(f"Batch complete: {len(results)} processed, {len(errors)} errors")

    return {
        'results': results,
        'errors': errors,
        'summary': {
            'total_processed': len(results),
            'total_errors': len(errors),
            'total_billed': sum(r['total_billed'] for r in results),
            'total_allowed': sum(r['total_allowed'] for r in results),
        }
    }


def serialize_result(result):
    """
    Serialize a result dict to JSON-safe format.
    Decimal objects aren't JSON-serializable by default.
    """
    def default_handler(obj):
        if isinstance(obj, Decimal):
            return float(obj)
        if isinstance(obj, (date, datetime)):
            return obj.isoformat()
        raise TypeError(f"Object of type {type(obj)} is not JSON serializable")

    return json.loads(json.dumps(result, default=default_handler))


if __name__ == '__main__':
    # Quick test - used during development
    test_benefits = {
        'annual_deductible': '1500.00',
        'deductible_met_ytd': '750.00',
        'coinsurance_in_network': 20,
        'oop_max': '6000.00',
        'oop_met_ytd': '1200.00',
        'in_network': True,
        'copays': {
            'office_visit': '30.00',
            'specialist': '50.00',
            'emergency': '250.00',
            'lab': '0.00'
        }
    }

    result = calculate_patient_responsibility(
        cpt_code='99213',
        diagnosis_codes=['J06.9', 'R05.9'],
        payer_id=PAYER_BCBS,
        contract_rates={
            PAYER_BCBS: {
                '99213': [{'effective_date': '2024-01-01', 'rate_type': 'fixed', 'amount': '120.00'}]
            }
        },
        patient_benefits=test_benefits,
        service_date=date(2024, 6, 15),
        rendering_provider_npi='1234567890'
    )

    print(json.dumps(serialize_result(result), indent=2))
