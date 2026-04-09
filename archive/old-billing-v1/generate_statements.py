"""
Meridian Health Technologies - Statement Generator v1 (DEPRECATED)

DEPRECATED: Replaced by services/billing statement generation module.

Generates patient billing statements as PDFs using ReportLab.
Known issues:
  - Long addresses overflow the address block
  - Multi-page statements sometimes have misaligned headers
  - Unicode characters in patient names cause crashes
  - Date formatting is inconsistent between sections

Original author: Priya Sharma
Created: 2020-06
Last modified: 2024-01
"""

import os
import logging
from datetime import datetime, date, timedelta
from decimal import Decimal, ROUND_HALF_UP

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, HRFlowable, Image
)
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER

logger = logging.getLogger(__name__)

# Statement configuration
COMPANY_NAME = 'Meridian Health Technologies'
COMPANY_ADDRESS_1 = '123 Healthcare Drive, Suite 400'
COMPANY_ADDRESS_2 = 'Boston, MA 02101'
COMPANY_PHONE = '1-888-555-0147'
COMPANY_WEBSITE = 'www.meridianhealth.io'
COMPANY_TAX_ID = '04-XXXXXXX'  # Redacted in this archived version

PAYMENT_DUE_DAYS = 30
LOGO_PATH = os.path.join(os.path.dirname(__file__), 'assets', 'logo.png')

# Payment coupon dimensions
COUPON_HEIGHT = 2.5 * inch


def generate_patient_statement(patient, charges, payments, output_path):
    """
    Generate a patient billing statement PDF.

    Args:
        patient: Dict with patient demographics
        charges: List of charge dicts (date, description, amount, etc.)
        payments: List of payment dicts
        output_path: File path for the generated PDF

    Returns:
        str: Path to the generated PDF file

    Known issues:
        - Addresses longer than 40 characters overflow the address block
        - If total charges exceed ~50 line items, the table formatting breaks
        - PDF/A compliance was never implemented despite being on the roadmap
    """
    doc = SimpleDocTemplate(
        output_path,
        pagesize=letter,
        rightMargin=0.75 * inch,
        leftMargin=0.75 * inch,
        topMargin=0.75 * inch,
        bottomMargin=1 * inch
    )

    styles = getSampleStyleSheet()

    # Custom styles
    styles.add(ParagraphStyle(
        name='StatementHeader',
        parent=styles['Heading1'],
        fontSize=18,
        textColor=colors.HexColor('#1a5276'),
        spaceAfter=6
    ))
    styles.add(ParagraphStyle(
        name='CompanyInfo',
        parent=styles['Normal'],
        fontSize=9,
        textColor=colors.HexColor('#555555'),
        leading=12
    ))
    styles.add(ParagraphStyle(
        name='PatientAddress',
        parent=styles['Normal'],
        fontSize=10,
        leading=14
    ))
    styles.add(ParagraphStyle(
        name='AmountDue',
        parent=styles['Heading2'],
        fontSize=14,
        textColor=colors.HexColor('#c0392b'),
        alignment=TA_RIGHT
    ))
    styles.add(ParagraphStyle(
        name='SmallText',
        parent=styles['Normal'],
        fontSize=7,
        textColor=colors.HexColor('#777777'),
        leading=9
    ))
    styles.add(ParagraphStyle(
        name='TableHeader',
        parent=styles['Normal'],
        fontSize=8,
        textColor=colors.white,
        alignment=TA_LEFT
    ))

    elements = []

    # ---- Header Section ----
    # Company logo and info (left) + Statement details (right)
    statement_date = datetime.now()
    due_date = statement_date + timedelta(days=PAYMENT_DUE_DAYS)
    statement_number = generate_statement_number(patient.get('account_number', ''), statement_date)

    # BUG: Logo path doesn't exist in most environments, causing a crash.
    # Added a try/except but the fallback text alignment is wrong.
    header_left = []
    try:
        if os.path.exists(LOGO_PATH):
            header_left.append(Image(LOGO_PATH, width=1.5 * inch, height=0.5 * inch))
        else:
            header_left.append(Paragraph(COMPANY_NAME, styles['StatementHeader']))
    except Exception:
        header_left.append(Paragraph(COMPANY_NAME, styles['StatementHeader']))

    header_left.extend([
        Paragraph(COMPANY_ADDRESS_1, styles['CompanyInfo']),
        Paragraph(COMPANY_ADDRESS_2, styles['CompanyInfo']),
        Paragraph(f'Phone: {COMPANY_PHONE}', styles['CompanyInfo']),
        Paragraph(f'Web: {COMPANY_WEBSITE}', styles['CompanyInfo']),
    ])

    header_right_data = [
        ['STATEMENT', ''],
        ['Statement Date:', statement_date.strftime('%m/%d/%Y')],
        ['Statement #:', statement_number],
        ['Account #:', patient.get('account_number', 'N/A')],
        ['Due Date:', due_date.strftime('%m/%d/%Y')],
    ]

    header_right_table = Table(header_right_data, colWidths=[1.5 * inch, 1.5 * inch])
    header_right_table.setStyle(TableStyle([
        ('FONT', (0, 0), (1, 0), 'Helvetica-Bold', 14),
        ('TEXTCOLOR', (0, 0), (1, 0), colors.HexColor('#1a5276')),
        ('SPAN', (0, 0), (1, 0)),
        ('FONT', (0, 1), (0, -1), 'Helvetica-Bold', 9),
        ('FONT', (1, 1), (1, -1), 'Helvetica', 9),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))

    # Two-column header layout
    header_table = Table(
        [[header_left, header_right_table]],
        colWidths=[4 * inch, 3 * inch]
    )
    header_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))

    elements.append(header_table)
    elements.append(Spacer(1, 0.3 * inch))
    elements.append(HRFlowable(width='100%', thickness=1, color=colors.HexColor('#1a5276')))
    elements.append(Spacer(1, 0.2 * inch))

    # ---- Patient Address Block ----
    patient_name = f"{patient.get('first_name', '')} {patient.get('last_name', '')}"
    patient_address = format_address(patient)

    elements.append(Paragraph(patient_name, styles['PatientAddress']))
    for line in patient_address:
        elements.append(Paragraph(line, styles['PatientAddress']))

    elements.append(Spacer(1, 0.3 * inch))

    # ---- Amount Due Summary ----
    total_charges = sum(Decimal(str(c.get('amount', 0))) for c in charges)
    total_payments = sum(Decimal(str(p.get('amount', 0))) for p in payments)
    total_adjustments = sum(
        Decimal(str(c.get('adjustment', 0))) for c in charges
    )
    balance_due = (total_charges - total_adjustments - total_payments).quantize(
        Decimal('0.01'), rounding=ROUND_HALF_UP
    )

    summary_data = [
        ['Total Charges:', f'${total_charges:,.2f}'],
        ['Insurance Adjustments:', f'-${total_adjustments:,.2f}'],
        ['Insurance Payments:', f'-${total_payments:,.2f}'],
        ['', ''],
        ['AMOUNT DUE:', f'${balance_due:,.2f}'],
    ]

    summary_table = Table(summary_data, colWidths=[2 * inch, 1.5 * inch])
    summary_table.setStyle(TableStyle([
        ('FONT', (0, 0), (-1, -2), 'Helvetica', 10),
        ('FONT', (0, -1), (-1, -1), 'Helvetica-Bold', 12),
        ('TEXTCOLOR', (0, -1), (-1, -1), colors.HexColor('#c0392b')),
        ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
        ('LINEABOVE', (0, -1), (-1, -1), 1, colors.black),
        ('TOPPADDING', (0, -1), (-1, -1), 8),
    ]))

    # Right-align the summary
    summary_wrapper = Table([[None, summary_table]], colWidths=[3.5 * inch, 3.5 * inch])
    elements.append(summary_wrapper)
    elements.append(Spacer(1, 0.3 * inch))

    # ---- Message to Patient ----
    if balance_due > 0:
        if balance_due > Decimal('500.00'):
            message = (
                'Your account has a balance due. We offer payment plans for balances '
                'over $200. Please call our billing department at 1-888-555-0147 to '
                'discuss payment options. You may also pay online at portal.meridianhealth.io.'
            )
        else:
            message = (
                'Please remit payment by the due date shown above. You may pay online '
                'at portal.meridianhealth.io, by phone at 1-888-555-0147, or by mail '
                'using the payment coupon below.'
            )
    else:
        message = 'No payment is due at this time. Thank you for choosing Meridian Health.'

    elements.append(Paragraph(message, styles['Normal']))
    elements.append(Spacer(1, 0.2 * inch))

    # ---- Charge Detail Table ----
    elements.append(Paragraph('Charge Details', styles['Heading3']))
    elements.append(Spacer(1, 0.1 * inch))

    table_data = [['Date', 'Description', 'Provider', 'Charges', 'Adj.', 'Paid', 'Balance']]

    for charge in charges:
        service_date = charge.get('service_date', '')
        if isinstance(service_date, (date, datetime)):
            service_date = service_date.strftime('%m/%d/%Y')

        # BUG: Long descriptions get truncated here but we never added
        # word wrapping. This caused some procedure descriptions to be
        # cut off in the PDF. The workaround was to use abbreviated descriptions.
        description = charge.get('description', '')[:45]

        charge_amount = Decimal(str(charge.get('amount', 0)))
        adjustment = Decimal(str(charge.get('adjustment', 0)))
        paid = Decimal(str(charge.get('insurance_paid', 0)))
        line_balance = (charge_amount - adjustment - paid).quantize(
            Decimal('0.01'), rounding=ROUND_HALF_UP
        )

        table_data.append([
            service_date,
            description,
            charge.get('provider_name', '')[:20],
            f'${charge_amount:,.2f}',
            f'${adjustment:,.2f}',
            f'${paid:,.2f}',
            f'${line_balance:,.2f}'
        ])

    charge_table = Table(
        table_data,
        colWidths=[0.85 * inch, 2 * inch, 1.1 * inch, 0.8 * inch, 0.7 * inch, 0.7 * inch, 0.85 * inch]
    )
    charge_table.setStyle(TableStyle([
        # Header row
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1a5276')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONT', (0, 0), (-1, 0), 'Helvetica-Bold', 8),
        ('FONT', (0, 1), (-1, -1), 'Helvetica', 8),
        # Alignment
        ('ALIGN', (3, 0), (-1, -1), 'RIGHT'),
        # Grid
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#dddddd')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f8f9fa')]),
        # Padding
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
    ]))

    elements.append(charge_table)
    elements.append(Spacer(1, 0.2 * inch))

    # ---- Payment History ----
    if payments:
        elements.append(Paragraph('Payment History', styles['Heading3']))
        elements.append(Spacer(1, 0.1 * inch))

        payment_data = [['Date', 'Description', 'Method', 'Amount']]
        for payment in payments:
            pay_date = payment.get('date', '')
            if isinstance(pay_date, (date, datetime)):
                pay_date = pay_date.strftime('%m/%d/%Y')

            payment_data.append([
                pay_date,
                payment.get('description', ''),
                payment.get('method', ''),
                f'${Decimal(str(payment.get("amount", 0))):,.2f}'
            ])

        payment_table = Table(payment_data, colWidths=[1 * inch, 3 * inch, 1.5 * inch, 1.5 * inch])
        payment_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#2c3e50')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONT', (0, 0), (-1, 0), 'Helvetica-Bold', 8),
            ('FONT', (0, 1), (-1, -1), 'Helvetica', 8),
            ('ALIGN', (3, 0), (3, -1), 'RIGHT'),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#dddddd')),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))

        elements.append(payment_table)
        elements.append(Spacer(1, 0.2 * inch))

    # ---- Important Notices ----
    elements.append(HRFlowable(width='100%', thickness=0.5, color=colors.HexColor('#cccccc')))
    elements.append(Spacer(1, 0.1 * inch))

    notices = [
        'This statement reflects charges and payments as of the statement date. '
        'Recent payments may not yet be reflected.',
        'If you have questions about your bill, please call 1-888-555-0147 '
        '(Mon-Fri, 8 AM - 6 PM ET).',
        'If you believe you have received this statement in error, or if your '
        'insurance information has changed, please contact us immediately.',
        'Financial assistance may be available. Visit meridianhealth.io/financial-assistance '
        'for more information.',
    ]

    for notice in notices:
        elements.append(Paragraph(f'* {notice}', styles['SmallText']))

    elements.append(Spacer(1, 0.2 * inch))

    # ---- Payment Coupon (tear-off) ----
    if balance_due > 0:
        elements.append(HRFlowable(
            width='100%', thickness=1,
            color=colors.black, dash=(3, 3)
        ))
        elements.append(Spacer(1, 0.1 * inch))
        elements.append(Paragraph(
            'PAYMENT COUPON - Please detach and return with your payment',
            ParagraphStyle('CouponHeader', parent=styles['Normal'],
                          fontSize=8, textColor=colors.HexColor('#666666'),
                          alignment=TA_CENTER)
        ))
        elements.append(Spacer(1, 0.1 * inch))

        coupon_data = [
            [f'Account #: {patient.get("account_number", "N/A")}',
             '',
             f'Statement #: {statement_number}'],
            [patient_name, '', f'Due Date: {due_date.strftime("%m/%d/%Y")}'],
            [patient_address[0] if patient_address else '',
             '',
             f'Amount Due: ${balance_due:,.2f}'],
            [patient_address[1] if len(patient_address) > 1 else '',
             '',
             'Amount Enclosed: $________'],
        ]

        coupon_table = Table(coupon_data, colWidths=[3 * inch, 1 * inch, 3 * inch])
        coupon_table.setStyle(TableStyle([
            ('FONT', (0, 0), (-1, -1), 'Helvetica', 9),
            ('FONT', (2, 2), (2, 2), 'Helvetica-Bold', 11),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
        ]))

        elements.append(coupon_table)
        elements.append(Spacer(1, 0.15 * inch))

        elements.append(Paragraph(
            f'Make checks payable to: {COMPANY_NAME}',
            styles['SmallText']
        ))
        elements.append(Paragraph(
            f'Mail to: {COMPANY_NAME}, PO Box 12345, Boston, MA 02101-2345',
            styles['SmallText']
        ))

    # Build the PDF
    try:
        doc.build(elements)
        logger.info(f"Statement generated: {output_path}")
        return output_path
    except Exception as e:
        logger.error(f"Failed to generate statement: {e}")
        raise


def format_address(patient):
    """
    Format patient address for display.

    BUG: This doesn't handle addresses longer than ~40 characters well.
    The address overflows the text block in the PDF. We tried wrapping
    but it caused alignment issues with the payment coupon.
    """
    lines = []
    addr = patient.get('address', {})

    street1 = addr.get('street1', '')
    street2 = addr.get('street2', '')
    city = addr.get('city', '')
    state = addr.get('state', '')
    zip_code = addr.get('zip', '')

    if street1:
        lines.append(street1)
    if street2:
        lines.append(street2)
    if city and state:
        lines.append(f'{city}, {state} {zip_code}')

    return lines


def generate_statement_number(account_number, statement_date):
    """Generate a unique statement number."""
    date_part = statement_date.strftime('%Y%m')
    return f'STMT-{account_number}-{date_part}'


def generate_batch_statements(patients_with_balances, output_dir):
    """
    Generate statements for all patients with outstanding balances.
    Run nightly by the cron job.

    Args:
        patients_with_balances: List of dicts with patient info, charges, payments
        output_dir: Directory to write PDFs to

    Returns:
        dict with generation results
    """
    os.makedirs(output_dir, exist_ok=True)

    results = {
        'generated': 0,
        'skipped': 0,
        'errors': 0,
        'total_amount': Decimal('0.00'),
        'files': []
    }

    for patient_data in patients_with_balances:
        patient = patient_data.get('patient', {})
        charges = patient_data.get('charges', [])
        payments = patient_data.get('payments', [])

        # Skip if balance is below minimum statement amount ($5)
        total_charges = sum(Decimal(str(c.get('amount', 0))) for c in charges)
        total_adjustments = sum(Decimal(str(c.get('adjustment', 0))) for c in charges)
        total_payments = sum(Decimal(str(p.get('amount', 0))) for p in payments)
        balance = total_charges - total_adjustments - total_payments

        if balance < Decimal('5.00'):
            results['skipped'] += 1
            logger.debug(f"Skipping patient {patient.get('account_number')}: balance ${balance} below minimum")
            continue

        # Generate filename
        account_num = patient.get('account_number', 'unknown')
        date_str = datetime.now().strftime('%Y%m%d')
        filename = f'statement_{account_num}_{date_str}.pdf'
        filepath = os.path.join(output_dir, filename)

        try:
            generate_patient_statement(patient, charges, payments, filepath)
            results['generated'] += 1
            results['total_amount'] += balance
            results['files'].append(filepath)
        except Exception as e:
            results['errors'] += 1
            logger.error(f"Error generating statement for {account_num}: {e}")

    logger.info(
        f"Batch statement generation complete: "
        f"{results['generated']} generated, "
        f"{results['skipped']} skipped, "
        f"{results['errors']} errors, "
        f"total amount: ${results['total_amount']:,.2f}"
    )

    return results


if __name__ == '__main__':
    # Test statement generation
    test_patient = {
        'first_name': 'Jane',
        'last_name': 'Doe',
        'account_number': 'MHT-100234',
        'address': {
            'street1': '456 Oak Avenue',
            'street2': 'Apt 7B',
            'city': 'Cambridge',
            'state': 'MA',
            'zip': '02139'
        }
    }

    test_charges = [
        {
            'service_date': date(2024, 5, 15),
            'description': 'Office Visit - Established Patient (99213)',
            'provider_name': 'Dr. Sarah Kim',
            'amount': '150.00',
            'adjustment': '52.48',
            'insurance_paid': '67.52',
        },
        {
            'service_date': date(2024, 5, 15),
            'description': 'Complete Blood Count (85025)',
            'provider_name': 'Dr. Sarah Kim',
            'amount': '35.00',
            'adjustment': '24.41',
            'insurance_paid': '10.59',
        },
    ]

    test_payments = [
        {
            'date': date(2024, 5, 15),
            'description': 'Copay - Office Visit',
            'method': 'Credit Card',
            'amount': '30.00',
        }
    ]

    output = '/tmp/test_statement.pdf'
    generate_patient_statement(test_patient, test_charges, test_payments, output)
    print(f'Statement generated: {output}')
