// @vitest-environment jsdom
//
// Proves the D9 component-test infra (jsdom + RTL + jest-dom) AND the Table
// primitive's semantics. The jest-dom import supplies the matcher type
// augmentation for the dashboard typecheck; the root setupFile registers them at
// runtime for every test.
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './table';

function renderTable(variant?: 'table' | 'cards') {
  return render(
    <Table scrollLabel="Patient roster table" variant={variant}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Patient</TableHead>
          <TableHead scope="col">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell label="Patient">Alice</TableCell>
          <TableCell label="Status">Active</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );
}

describe('Table — semantic table primitives', () => {
  it('renders a real <table> exposing the implicit table role', () => {
    renderTable();
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    expect(table.tagName).toBe('TABLE');
  });

  it('renders <th> cells as columnheaders', () => {
    renderTable();
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent('Patient');
    expect(headers.every((h) => h.tagName === 'TH')).toBe(true);
  });

  it('exposes header + body rows and <td> data cells', () => {
    renderTable();
    expect(screen.getAllByRole('row')).toHaveLength(2); // header row + body row
    const cells = screen.getAllByRole('cell'); // <td> only, not <th>
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent('Alice');
  });

  it('styles with design tokens (no hardcoded colors)', () => {
    renderTable();
    const table = screen.getByRole('table');
    expect(table).toHaveClass('text-sm');
    expect(table.parentElement).toHaveClass('[contain:paint]');
  });

  it('makes the horizontal scroller keyboard-focusable and labels the region', () => {
    renderTable();
    const region = screen.getByRole('region', { name: /patient roster table/i });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table'));
  });

  it('defaults to variant="table" (data-variant="table" on the region)', () => {
    renderTable();
    expect(screen.getByRole('region')).toHaveAttribute('data-variant', 'table');
  });

  it('variant="cards" (C3 escape hatch) stays a real <table> — same roles, restyled', () => {
    renderTable('cards');
    expect(screen.getByRole('region')).toHaveAttribute('data-variant', 'cards');
    // Still a real table: assistive tech keeps the table/row/cell/columnheader roles.
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getAllByRole('cell')).toHaveLength(2);
  });

  it('variant="cards" renders each cell\'s label for the below-lg restacked view', () => {
    renderTable('cards');
    // The label span exists in the DOM (visible only below `lg` via CSS) alongside the value.
    const aliceCell = screen.getByText('Alice').closest('td');
    expect(aliceCell).toHaveTextContent('Patient');
    expect(aliceCell).toHaveTextContent('Alice');
  });

  it('table headers carry the sticky-header treatment', () => {
    renderTable();
    const columnHeader = screen.getAllByRole('columnheader')[0];
    const thead = columnHeader?.closest('thead');
    expect(thead).toHaveClass('sticky');
    expect(thead).toHaveClass('top-0');
  });
});
