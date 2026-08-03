import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import {
  createEditedPdf,
  refreshFormTextAppearances,
  validateChanges,
} from '../src/pdf-engine.js';

async function createFixture(pageCount = 3) {
  const document = await PDFDocument.create();
  document.setTitle('Documento de prueba');
  document.setAuthor('Folentra PDF');

  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([200 + index * 10, 300 + index * 10]);
  }

  return document.save({ useObjectStreams: false });
}

async function createAcroFormFixture() {
  const document = await PDFDocument.create();
  const page = document.addPage([500, 600]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const form = document.getForm();
  const appearance = {
    borderColor: rgb(0.15, 0.23, 0.35),
    backgroundColor: rgb(0.96, 0.97, 0.99),
    borderWidth: 1,
  };

  const text = form.createTextField('fixture.person.name');
  text.setText('Ada Lovelace');
  text.addToPage(page, {
    ...appearance,
    font,
    x: 40,
    y: 480,
    width: 220,
    height: 28,
  });

  const checkbox = form.createCheckBox('fixture.accepted');
  checkbox.addToPage(page, {
    ...appearance,
    x: 40,
    y: 425,
    width: 22,
    height: 22,
  });
  checkbox.check();

  const radio = form.createRadioGroup('fixture.plan');
  radio.addOptionToPage('basic', page, {
    ...appearance,
    x: 40,
    y: 370,
    width: 22,
    height: 22,
  });
  radio.addOptionToPage('pro', page, {
    ...appearance,
    x: 90,
    y: 370,
    width: 22,
    height: 22,
  });
  radio.select('pro');

  const dropdown = form.createDropdown('fixture.country');
  dropdown.setOptions(['Mexico', 'Canada', 'Spain']);
  dropdown.select('Mexico');
  dropdown.addToPage(page, {
    ...appearance,
    font,
    x: 40,
    y: 300,
    width: 180,
    height: 28,
  });

  const optionList = form.createOptionList('fixture.interests');
  optionList.setOptions(['Science', 'Music', 'Travel']);
  optionList.enableMultiselect();
  optionList.select(['Science', 'Travel']);
  optionList.addToPage(page, {
    ...appearance,
    font,
    x: 40,
    y: 185,
    width: 180,
    height: 75,
  });

  form.updateFieldAppearances(font);
  return document.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

function decodedPageContent(document, pageIndex) {
  const contents = document.getPage(pageIndex).node.Contents();
  if (!contents) return '';

  const streams = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, index) => (
      document.context.lookup(contents.get(index), PDFRawStream)
    ))
    : [document.context.lookup(contents, PDFRawStream)];

  return streams
    .map((stream) => new TextDecoder().decode(decodePDFRawStream(stream).decode()))
    .join('\n');
}

test('validateChanges normalizes bounded values and original page indices', () => {
  const normalized = validateChanges({
    texts: [{
      pageIndex: '1',
      x: Number.POSITIVE_INFINITY,
      y: -50,
      text: `hola\0${'x'.repeat(5_000)}`,
      size: 2_000,
      color: '#ABC',
    }],
    highlights: [{
      pageIndex: 0,
      x: 30,
      y: 40,
      width: -10,
      height: -20,
      color: 'bad-color',
      opacity: 9,
    }],
    formFields: [{
      pageIndex: 0,
      x: 150,
      y: 90,
      width: -80,
      height: -24,
      fieldName: '  Campo.  principal  ',
    }],
    inks: [{
      pageIndex: 0,
      points: [[1, 2], { x: 3, y: 4 }, { x: 'bad', y: 5 }],
      width: 0,
      opacity: -1,
    }],
    rotations: new Map([[1, 91]]),
    deletedPages: [2, 2, 99],
  }, 3);

  assert.equal(normalized.texts[0].text.length, 4_096);
  assert.equal(normalized.texts[0].x, 0);
  assert.equal(normalized.texts[0].size, 512);
  assert.equal(normalized.texts[0].color, '#aabbcc');
  assert.deepEqual(
    normalized.highlights[0],
    {
      pageIndex: 0,
      x: 20,
      y: 20,
      width: 10,
      height: 20,
      color: '#fde047',
      opacity: 1,
    },
  );
  assert.equal(normalized.inks[0].points.length, 2);
  assert.equal(normalized.inks[0].width, 0.1);
  assert.equal(normalized.inks[0].opacity, 0);
  assert.deepEqual(
    normalized.formFields[0],
    {
      pageIndex: 0,
      x: 70,
      y: 66,
      width: 80,
      height: 24,
      fieldName: 'Campo principal',
    },
  );
  assert.deepEqual(normalized.rotations, [{ pageIndex: 1, delta: 90 }]);
  assert.deepEqual(normalized.deletedPages, [2]);
});

test('writes text, highlight and ink operators into a reopenable PDF', async () => {
  const original = await createFixture(1);
  const output = await createEditedPdf(original, {
    texts: [{
      pageIndex: 0,
      x: 12,
      y: 270,
      text: 'Texto compatible: edición local',
      size: 16,
      color: '#ff0000',
    }],
    highlights: [{
      pageIndex: 0,
      x: 10,
      y: 240,
      width: 80,
      height: 18,
      color: '#00ff00',
      opacity: 0.25,
    }],
    inks: [{
      pageIndex: 0,
      points: [{ x: 10, y: 10 }, { x: 30, y: 35 }, { x: 60, y: 20 }],
      color: '#0000ff',
      width: 3,
      opacity: 0.8,
    }],
  });

  assert.ok(output instanceof Uint8Array);
  const reopened = await PDFDocument.load(output);
  assert.equal(reopened.getPageCount(), 1);

  const content = decodedPageContent(reopened, 0);
  assert.match(content, /\bBT\b/);
  assert.match(content, /\bTj\b/);
  assert.match(content, /0 1 0 rg/);
  assert.match(content, /\bh\nf\b/);
  assert.match(content, /\bm\b/);
  assert.match(content, /\bl\b/);
  assert.match(content, /\bS\b/);
});

test('rejects unsupported Unicode instead of silently changing it', async () => {
  const original = await createFixture(1);
  await assert.rejects(
    createEditedPdf(original, {
      texts: [{
        pageIndex: 0,
        x: 12,
        y: 270,
        text: 'Emoji no compatible: 🪶',
        size: 16,
        color: '#ff0000',
      }],
    }),
    /caracteres.*no puede guardar/u,
  );
});

test('uses original indices for rotation and descending page deletion', async () => {
  const original = await createFixture(3);
  const output = await createEditedPdf(original, {
    rotations: [{ pageIndex: 1, delta: 90 }],
    deletedPages: new Set([2, 0]),
  });

  const reopened = await PDFDocument.load(output, { updateMetadata: false });
  assert.equal(reopened.getPageCount(), 1);
  assert.equal(reopened.getPage(0).getWidth(), 210);
  assert.equal(reopened.getPage(0).getHeight(), 310);
  assert.equal(reopened.getPage(0).getRotation().angle, 90);
  assert.equal(reopened.getTitle(), 'Documento de prueba');
  assert.equal(reopened.getAuthor(), 'Folentra PDF');
});

test('rotation is a delta from the source page rotation', async () => {
  const fixture = await PDFDocument.create();
  const page = fixture.addPage([200, 300]);
  page.setRotation({ type: 'degrees', angle: 90 });
  const original = await fixture.save();

  const output = await createEditedPdf(original, {
    rotations: { 0: 270 },
  });
  const reopened = await PDFDocument.load(output);

  assert.equal(reopened.getPage(0).getRotation().angle, 0);
});

test('refuses to delete every page', async () => {
  const original = await createFixture(2);

  await assert.rejects(
    createEditedPdf(original, { deletedPages: [0, 1] }),
    /retain at least one page/,
  );
});

test('creates uniquely named interactive AcroForm text fields with appearances', async () => {
  const fixture = await PDFDocument.create();
  const page = fixture.addPage([300, 200]);
  const fixtureForm = fixture.getForm();
  const existing = fixtureForm.createTextField('FolentraPDF_Campo_1');
  existing.addToPage(page, {
    x: 20,
    y: 145,
    width: 120,
    height: 24,
  });
  const nested = fixtureForm.createTextField('FolentraPDF_Campo_2.child');
  nested.addToPage(page, {
    x: 155,
    y: 145,
    width: 120,
    height: 24,
  });
  const original = await fixture.save({
    updateFieldAppearances: true,
    useObjectStreams: false,
  });

  const output = await createEditedPdf(original, {
    formFields: [
      {
        pageIndex: 0,
        x: 30,
        y: 90,
        width: 180,
        height: 28,
        fieldName: 'Campo rellenable',
      },
      {
        pageIndex: 0,
        x: 30,
        y: 45,
        width: 180,
        height: 28,
        fieldName: 'Campo rellenable',
      },
    ],
  });

  const reopened = await PDFDocument.load(output, { updateMetadata: false });
  const form = reopened.getForm();
  const acroForm = reopened.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const defaultFonts = acroForm
    .lookup(PDFName.of('DR'), PDFDict)
    .lookup(PDFName.of('Font'), PDFDict);
  assert.ok(defaultFonts.has(PDFName.of('Helvetica')));
  assert.deepEqual(
    form.getFields().map((field) => field.getName()),
    [
      'FolentraPDF_Campo_1',
      'FolentraPDF_Campo_2.child',
      'FolentraPDF_Campo_3',
      'FolentraPDF_Campo_4',
    ],
  );

  for (const fieldName of ['FolentraPDF_Campo_3', 'FolentraPDF_Campo_4']) {
    const field = form.getTextField(fieldName);
    assert.equal(field.getText(), undefined);
    assert.equal(field.needsAppearancesUpdate(), false);
    assert.equal(
      field.acroField.dict.lookup(PDFName.of('TU')).decodeText(),
      'Campo rellenable',
    );
    const [widget] = field.acroField.getWidgets();
    assert.ok(widget.getAppearances()?.normal);
    assert.equal(widget.P(), reopened.getPage(0).ref);
  }

  const annotations = reopened.getPage(0).node.Annots();
  assert.equal(annotations.size(), 4);
  assert.deepEqual(
    form.getTextField('FolentraPDF_Campo_3').acroField.getWidgets()[0].getRectangle(),
    { x: 30, y: 90, width: 180, height: 28 },
  );
});

test('removes form fields and widgets that belong to deleted pages', async () => {
  const fixture = await PDFDocument.create();
  const firstPage = fixture.addPage([300, 200]);
  const secondPage = fixture.addPage([300, 200]);
  const font = await fixture.embedFont(StandardFonts.Helvetica);
  const form = fixture.getForm();

  const removed = form.createTextField('page.removed');
  removed.setText('Eliminar');
  removed.addToPage(firstPage, {
    font,
    x: 20,
    y: 140,
    width: 120,
    height: 24,
  });

  const kept = form.createTextField('page.kept');
  kept.setText('Conservar');
  kept.addToPage(secondPage, {
    font,
    x: 20,
    y: 140,
    width: 120,
    height: 24,
  });

  const shared = form.createTextField('page.shared');
  shared.setText('Compartido');
  shared.addToPage(firstPage, {
    font,
    x: 20,
    y: 90,
    width: 120,
    height: 24,
  });
  shared.addToPage(secondPage, {
    font,
    x: 20,
    y: 90,
    width: 120,
    height: 24,
  });

  const original = await fixture.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
  const output = await createEditedPdf(original, { deletedPages: [0] });
  const reopened = await PDFDocument.load(output, { updateMetadata: false });
  const reopenedForm = reopened.getForm();

  assert.equal(reopened.getPageCount(), 1);
  assert.equal(reopenedForm.getFieldMaybe('page.removed'), undefined);
  assert.equal(reopenedForm.getTextField('page.kept').getText(), 'Conservar');
  assert.equal(reopenedForm.getTextField('page.shared').getText(), 'Compartido');
  assert.equal(
    reopenedForm.getTextField('page.shared').acroField.getWidgets().length,
    1,
  );
  assert.equal(reopened.getPage(0).node.Annots().size(), 2);
});

test('preserves interactive AcroForm fields, values and appearances after visual edits', async () => {
  const original = await createAcroFormFixture();
  const output = await createEditedPdf(original, {
    highlights: [{
      pageIndex: 0,
      x: 300,
      y: 530,
      width: 130,
      height: 20,
      color: '#fde047',
      opacity: 0.35,
    }],
  });

  const reopened = await PDFDocument.load(output, { updateMetadata: false });
  const acroForm = reopened.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const rootFields = acroForm.lookup(PDFName.of('Fields'), PDFArray);
  assert.ok(rootFields.size() > 0, 'the AcroForm field tree must remain present');

  const form = reopened.getForm();
  const fields = form.getFields();
  assert.equal(fields.length, 5);
  assert.equal(form.getTextField('fixture.person.name').getText(), 'Ada Lovelace');
  assert.equal(form.getCheckBox('fixture.accepted').isChecked(), true);
  assert.equal(form.getRadioGroup('fixture.plan').getSelected(), 'pro');
  assert.deepEqual(form.getDropdown('fixture.country').getSelected(), ['Mexico']);
  assert.deepEqual(
    form.getOptionList('fixture.interests').getSelected(),
    ['Science', 'Travel'],
  );

  let widgetCount = 0;
  for (const field of fields) {
    assert.equal(
      field.needsAppearancesUpdate(),
      false,
      `${field.getName()} must retain a usable appearance`,
    );
    const widgets = field.acroField.getWidgets();
    assert.ok(widgets.length > 0, `${field.getName()} must remain interactive`);
    widgetCount += widgets.length;
    for (const widget of widgets) {
      assert.ok(
        widget.getAppearances()?.normal,
        `${field.getName()} widget must retain a normal appearance stream`,
      );
    }
  }

  const annotations = reopened.getPage(0).node.Annots();
  assert.ok(annotations instanceof PDFArray);
  assert.equal(annotations.size(), widgetCount);
  for (let index = 0; index < annotations.size(); index += 1) {
    const annotation = reopened.context.lookup(annotations.get(index), PDFDict);
    const subtype = annotation.lookup(PDFName.of('Subtype'), PDFName);
    assert.equal(subtype.decodeText(), 'Widget');
  }

  const content = decodedPageContent(reopened, 0);
  assert.match(content, /1 0\.8784313725490196 0\.2784313725490196 rg/);
  assert.match(content, /\bh\nf\b/);
});

test('refreshes appearances on canonical and detached page widgets', async () => {
  const fixture = await PDFDocument.create();
  const page = fixture.addPage([300, 200]);
  const font = await fixture.embedFont(StandardFonts.Helvetica);
  const textField = fixture.getForm().createTextField('detached.name');
  textField.setText('Valor inicial');
  textField.addToPage(page, {
    font,
    x: 30,
    y: 100,
    width: 200,
    height: 30,
  });
  const original = await fixture.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });

  const pending = await PDFDocument.load(original, { updateMetadata: false });
  pending.getForm().getTextField('detached.name').setText('Valor actualizado');
  const annotations = pending.getPage(0).node.Annots();
  const canonicalRef = annotations.get(0);
  const canonicalWidget = pending.context.lookup(canonicalRef, PDFDict);
  const detachedWidget = canonicalWidget.clone(pending.context);
  detachedWidget.delete(PDFName.of('AP'));
  annotations.set(0, pending.context.register(detachedWidget));
  const withoutPageAppearance = await pending.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });

  const output = await refreshFormTextAppearances(
    withoutPageAppearance,
    ['detached.name'],
  );
  const reopened = await PDFDocument.load(output, { updateMetadata: false });
  assert.equal(
    reopened.getForm().getTextField('detached.name').getText(),
    'Valor actualizado',
  );

  const reopenedAnnotations = reopened.getPage(0).node.Annots();
  const pageWidget = reopened.context.lookup(reopenedAnnotations.get(0), PDFDict);
  const normalAppearance = pageWidget
    .lookup(PDFName.of('AP'), PDFDict)
    .get(PDFName.of('N'));
  assert.ok(normalAppearance, 'the detached page widget must receive a normal appearance');
  assert.equal(
    reopened.getForm().getTextField('detached.name').needsAppearancesUpdate(),
    false,
  );
});
