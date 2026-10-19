import { describe, expect, it, vi } from 'vitest';

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import ReviewsPage from './page';

describe('/reviews index', () => {
  it('redirects to the safety queue', () => {
    expect(() => ReviewsPage()).toThrow('NEXT_REDIRECT:/reviews/safety');
    expect(redirectMock).toHaveBeenCalledWith('/reviews/safety');
  });
});
